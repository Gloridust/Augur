import { useEffect, useMemo, useState } from 'react';
import { extractDomain } from '../../shared/db';
import type { DomainGroup, WindowGroup } from '../../shared/types';

export interface UseTabsResult {
  tabs: chrome.tabs.Tab[];
  groups: DomainGroup[];
  windowGroups: WindowGroup[];
  refresh: () => void;
}

export function useTabs(): UseTabsResult {
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);

  const refresh = useMemo(
    () => () => {
      if (!chrome?.tabs?.query) return;
      chrome.tabs.query({}, (result) => setTabs(result));
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

export async function closeTabs(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await chrome.tabs.remove(ids);
}

export async function activateTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}
