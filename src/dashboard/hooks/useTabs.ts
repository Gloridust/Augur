import { useEffect, useMemo, useState } from 'react';
import { extractDomain } from '../../shared/db';
import type { DomainGroup, WindowGroup } from '../../shared/types';

export interface UseTabsResult {
  tabs: chrome.tabs.Tab[];
  groups: DomainGroup[];
  windowGroups: WindowGroup[];
  refresh: () => void;
}

// True for any tab that is the dashboard itself (newtab override OR direct
// chrome-extension URL). These should never appear in the tab wall and must
// never be returned by close/stash actions — closing the dashboard out from
// under the user is a hostile UX.
export function isDashboardTab(tab: chrome.tabs.Tab): boolean {
  if (!tab.url && !tab.pendingUrl) return false;
  const url = tab.url ?? tab.pendingUrl ?? '';
  if (url === 'chrome://newtab/' || url === 'chrome://new-tab-page/') return true;
  if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) {
    const dashUrl = chrome.runtime.getURL('src/dashboard/index.html');
    if (url === dashUrl) return true;
    // The CRX plugin sometimes adds a query string in dev. Match prefix too.
    if (url.startsWith(dashUrl)) return true;
  }
  return false;
}

export function dashboardUrl(): string {
  if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) {
    return chrome.runtime.getURL('src/dashboard/index.html');
  }
  return '';
}

export function useTabs(): UseTabsResult {
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);

  const refresh = useMemo(
    () => () => {
      if (!chrome?.tabs?.query) return;
      chrome.tabs.query({}, (result) => {
        // Hide the dashboard itself from the tab wall — it's the surface
        // the user is currently looking at, listing it just creates a
        // "wait, why can't I close that?" dead end.
        setTabs(result.filter((t) => !isDashboardTab(t)));
      });
    },
    [],
  );

  useEffect(() => {
    refresh();
    if (!chrome?.tabs) return;
    const onChanged = () => refresh();
    chrome.tabs.onCreated.addListener(onChanged);
    chrome.tabs.onRemoved.addListener(onChanged);
    chrome.tabs.onUpdated.addListener(onChanged);
    chrome.tabs.onMoved.addListener(onChanged);
    chrome.tabs.onActivated.addListener(onChanged);
    chrome.tabs.onAttached.addListener(onChanged);
    chrome.tabs.onDetached.addListener(onChanged);
    return () => {
      chrome.tabs.onCreated.removeListener(onChanged);
      chrome.tabs.onRemoved.removeListener(onChanged);
      chrome.tabs.onUpdated.removeListener(onChanged);
      chrome.tabs.onMoved.removeListener(onChanged);
      chrome.tabs.onActivated.removeListener(onChanged);
      chrome.tabs.onAttached.removeListener(onChanged);
      chrome.tabs.onDetached.removeListener(onChanged);
    };
  }, [refresh]);

  const groups = useMemo<DomainGroup[]>(() => {
    const buckets = new Map<string, chrome.tabs.Tab[]>();
    for (const tab of tabs) {
      const domain = extractDomain(tab.url) || '(other)';
      const list = buckets.get(domain) ?? [];
      list.push(tab);
      buckets.set(domain, list);
    }
    return Array.from(buckets.entries())
      .map(([domain, t]) => ({ domain, tabs: t }))
      .sort((a, b) => b.tabs.length - a.tabs.length || a.domain.localeCompare(b.domain));
  }, [tabs]);

  const windowGroups = useMemo<WindowGroup[]>(() => {
    const buckets = new Map<number, chrome.tabs.Tab[]>();
    for (const tab of tabs) {
      const wid = tab.windowId ?? -1;
      const list = buckets.get(wid) ?? [];
      list.push(tab);
      buckets.set(wid, list);
    }
    const sortedWindowIds = Array.from(buckets.keys()).sort((a, b) => a - b);
    return sortedWindowIds.map((windowId, index) => {
      const list = (buckets.get(windowId) ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const active = list.find((t) => t.active);
      return {
        windowId,
        windowIndex: index,
        tabs: list,
        activeTabTitle: active?.title,
      };
    });
  }, [tabs]);

  return { tabs, groups, windowGroups, refresh };
}

// Defensive close — re-queries all tabs and never includes a dashboard tab,
// even if the caller somehow handed us its id (e.g., from stale state).
export async function closeTabs(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  let safe = ids;
  if (typeof chrome !== 'undefined' && chrome?.tabs?.query) {
    const all = await chrome.tabs.query({});
    const dashIds = new Set(all.filter(isDashboardTab).map((t) => t.id));
    safe = ids.filter((id) => !dashIds.has(id));
  }
  if (safe.length === 0) return;
  await chrome.tabs.remove(safe);
}

export async function activateTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}
