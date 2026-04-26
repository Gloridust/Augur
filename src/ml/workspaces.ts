import { db, extractDomain } from '../shared/db';
import type { Workspace, WorkspaceTab } from '../shared/types';

export interface SaveWorkspaceInput {
  name: string;
  tabs: WorkspaceTab[];
}

function uniqueDomains(tabs: WorkspaceTab[]): string[] {
  const set = new Set<string>();
  for (const t of tabs) {
    const d = extractDomain(t.url);
    if (d) set.add(d);
  }
  return Array.from(set);
}

export async function saveWorkspace(input: SaveWorkspaceInput): Promise<number> {
  const now = Date.now();
  const ws: Workspace = {
    name: input.name,
    tabs: input.tabs,
    domains: uniqueDomains(input.tabs),
    createdAt: now,
    updatedAt: now,
  };
  return (await db.workspaces.add(ws)) as number;
}

export async function updateWorkspace(
  id: number,
  patch: Partial<Pick<Workspace, 'name' | 'tabs'>>,
): Promise<void> {
  const existing = await db.workspaces.get(id);
  if (!existing) return;
  const tabs = patch.tabs ?? existing.tabs;
  const next: Workspace = {
    ...existing,
    name: patch.name ?? existing.name,
    tabs,
    domains: uniqueDomains(tabs),
    updatedAt: Date.now(),
  };
  await db.workspaces.put(next);
}

export async function deleteWorkspace(id: number): Promise<void> {
  await db.workspaces.delete(id);
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return db.workspaces.orderBy('updatedAt').reverse().toArray();
}

export async function restoreWorkspace(
  id: number,
  mode: 'newWindow' | 'currentWindow',
): Promise<void> {
  const ws = await db.workspaces.get(id);
  if (!ws || ws.tabs.length === 0) return;
  if (mode === 'newWindow') {
    const win = await chrome.windows.create({
      url: ws.tabs[0].url,
      focused: true,
    });
    if (!win?.id) return;
    for (let i = 1; i < ws.tabs.length; i++) {
      const t = ws.tabs[i];
      await chrome.tabs.create({
        windowId: win.id,
        url: t.url,
        active: false,
        pinned: t.pinned,
      });
    }
  } else {
    for (const t of ws.tabs) {
      await chrome.tabs.create({ url: t.url, active: false, pinned: t.pinned });
    }
  }
}
