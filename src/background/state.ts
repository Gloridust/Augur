// Service-worker runtime state: per-tab focus accounting, the focused tab,
// and the system idle state.
//
// Kept IN MEMORY and persisted to chrome.storage.session (which survives SW
// sleep, not browser restarts). The previous implementation re-read and
// re-wrote the entire tab map on every get/set — ~4 full-map round-trips per
// event and O(n²) writes when reconciling 118 tabs at startup. Now:
//   - the map is loaded once per SW lifetime (promise-cached, race-free),
//   - reads/writes hit the in-memory object,
//   - the map is persisted with a short debounce (one write per burst).
// All mutations happen inside the serial event queue (./queue), so there's a
// single writer and no lost updates.

import type { TabRuntimeState } from '../shared/types';

const STATE_KEY = 'tabRuntimeState';
const IDLE_KEY = 'idleState';
const FOCUSED_TAB_KEY = 'focusedTabId';
const PERSIST_DELAY_MS = 1000;

export type StateMap = Record<number, TabRuntimeState>;

interface RuntimeState {
  map: StateMap;
  focusedTabId: number | undefined;
  idle: chrome.idle.IdleState;
}

let loaded: Promise<RuntimeState> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Promise<RuntimeState> {
  loaded ??= chrome.storage.session
    .get([STATE_KEY, FOCUSED_TAB_KEY, IDLE_KEY])
    .then((out) => ({
      map: (out[STATE_KEY] as StateMap | undefined) ?? {},
      focusedTabId: out[FOCUSED_TAB_KEY] as number | undefined,
      idle: (out[IDLE_KEY] as chrome.idle.IdleState | undefined) ?? 'active',
    }))
    .catch((err) => {
      loaded = null;
      throw err;
    });
  return loaded;
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushState();
  }, PERSIST_DELAY_MS);
}

export async function flushState(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!loaded) return;
  const s = await loaded;
  await chrome.storage.session.set({ [STATE_KEY]: s.map });
}

// Returns the LIVE map — read-only for callers; mutate via setTabState.
export async function getStateMap(): Promise<StateMap> {
  return (await load()).map;
}

export async function getTabState(tabId: number): Promise<TabRuntimeState | undefined> {
  return (await load()).map[tabId];
}

export async function setTabState(state: TabRuntimeState): Promise<void> {
  (await load()).map[state.tabId] = state;
  schedulePersist();
}

// Replace the whole map in one write (startup reconcile).
export async function replaceStateMap(map: StateMap): Promise<void> {
  (await load()).map = map;
  schedulePersist();
}

export async function deleteTabState(tabId: number): Promise<TabRuntimeState | undefined> {
  const s = await load();
  const prev = s.map[tabId];
  delete s.map[tabId];
  schedulePersist();
  return prev;
}

export async function getFocusedTabId(): Promise<number | undefined> {
  return (await load()).focusedTabId;
}

export async function setFocusedTabId(tabId: number | undefined): Promise<void> {
  (await load()).focusedTabId = tabId;
  await chrome.storage.session.set({ [FOCUSED_TAB_KEY]: tabId });
}

export async function getIdleState(): Promise<chrome.idle.IdleState> {
  return (await load()).idle;
}

export async function setIdleState(idle: chrome.idle.IdleState): Promise<void> {
  (await load()).idle = idle;
  await chrome.storage.session.set({ [IDLE_KEY]: idle });
}
