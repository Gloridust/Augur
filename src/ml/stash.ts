import { db, extractDomain } from '../shared/db';
import type { StashedTab } from '../shared/types';

export interface StashInput {
  url: string;
  title?: string;
  favIconUrl?: string;
  source: 'manual' | 'cleanup';
}

export async function stashTabs(items: StashInput[]): Promise<number[]> {
  const now = Date.now();
  const records: StashedTab[] = items.map((it) => ({
    url: it.url,
    title: it.title ?? extractDomain(it.url) ?? it.url,
    favIconUrl: it.favIconUrl,
    domain: extractDomain(it.url),
    stashedAt: now,
    source: it.source,
  }));
  const ids: number[] = [];
  for (const r of records) {
    const id = (await db.stash.add(r)) as number;
    ids.push(id);
  }
  return ids;
}

export async function listStash(): Promise<StashedTab[]> {
  return db.stash.orderBy('stashedAt').reverse().toArray();
}

export async function unstashOne(id: number): Promise<StashedTab | undefined> {
  const item = await db.stash.get(id);
  if (item) await db.stash.delete(id);
  return item;
}

export async function deleteStashed(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.stash.bulkDelete(ids);
}

export async function clearStash(): Promise<void> {
  await db.stash.clear();
}
