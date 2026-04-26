import type { TabRuntimeState } from '../shared/types';

const STATE_KEY = 'tabRuntimeState';
const IDLE_KEY = 'idleState';
const FOCUSED_TAB_KEY = 'focusedTabId';

type StateMap = Record<number, TabRuntimeState>;

async function read<T>(key: string, fallback: T): Promise<T> {
  const out = await chrome.storage.session.get(key);
  return (out[key] as T | undefined) ?? fallback;
}

async function write(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

export async function getStateMap(): Promise<StateMap> {
  return read<StateMap>(STATE_KEY, {});
}

export async function getTabState(tabId: number): Promise<TabRuntimeState | undefined> {
  const map = await getStateMap();
  return map[tabId];
}

export async function setTabState(state: TabRuntimeState): Promise<void> {
  const map = await getStateMap();
  map[state.tabId] = state;
  await write(STATE_KEY, map);
}

export async function deleteTabState(tabId: number): Promise<TabRuntimeState | undefined> {
  const map = await getStateMap();
  const prev = map[tabId];
  delete map[tabId];
  await write(STATE_KEY, map);
  return prev;
}

export async function getFocusedTabId(): Promise<number | undefined> {
  return read<number | undefined>(FOCUSED_TAB_KEY, undefined);
}

export async function setFocusedTabId(tabId: number | undefined): Promise<void> {
  await write(FOCUSED_TAB_KEY, tabId);
}

export async function getIdleState(): Promise<chrome.idle.IdleState> {
  return read<chrome.idle.IdleState>(IDLE_KEY, 'active');
}

export async function setIdleState(s: chrome.idle.IdleState): Promise<void> {
  await write(IDLE_KEY, s);
}
