// In-memory stand-in for the chrome.* extension APIs the service worker and
// ML code touch. Every `onX` is a ChromeEvent whose `fire()` invokes the real
// listeners the code under test registered, so tests drive the actual SW
// event handlers instead of re-implementing them.

/* eslint-disable @typescript-eslint/no-explicit-any */

type Listener = (...args: any[]) => any;

export class ChromeEvent {
  listeners: Listener[] = [];
  addListener = (fn: Listener) => {
    this.listeners.push(fn);
  };
  removeListener = (fn: Listener) => {
    this.listeners = this.listeners.filter((l) => l !== fn);
  };
  hasListener = (fn: Listener) => this.listeners.includes(fn);
  /** Invoke every listener WITHOUT awaiting between them — the way Chrome
   *  dispatches: back-to-back, each async handler runs concurrently. */
  fire(...args: any[]): Promise<unknown[]> {
    return Promise.all(this.listeners.map((l) => Promise.resolve(l(...args))));
  }
}

function storageArea() {
  let data: Record<string, unknown> = {};
  return {
    get: async (keys?: string | string[] | Record<string, unknown> | null) => {
      if (keys == null) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
    remove: async (keys: string | string[]) => {
      for (const k of typeof keys === 'string' ? [keys] : keys) delete data[k];
    },
    clear: async () => {
      data = {};
    },
    _dump: () => data,
  };
}

export interface MockTab {
  id: number;
  windowId: number;
  url?: string;
  title?: string;
  active?: boolean;
  pinned?: boolean;
  groupId?: number;
  index?: number;
  audible?: boolean;
  discarded?: boolean;
  lastAccessed?: number;
  openerTabId?: number;
}

export function createChromeMock() {
  const tabs = new Map<number, MockTab>();
  const alarms = new Map<string, { name: string; periodInMinutes?: number }>();
  const badge = { text: '', color: '' };
  const counters = { tabsQuery: 0 };

  const chrome: any = {
    runtime: {
      id: 'test-extension',
      getURL: (p: string) => `chrome-extension://test-extension/${p}`,
      onInstalled: new ChromeEvent(),
      onStartup: new ChromeEvent(),
      onMessage: new ChromeEvent(),
      sendMessage: async () => undefined,
    },
    storage: { session: storageArea(), local: storageArea() },
    tabs: {
      query: async (q: Record<string, unknown> = {}) => {
        counters.tabsQuery++;
        let list = [...tabs.values()];
        if (q.active !== undefined) list = list.filter((t) => !!t.active === q.active);
        if (q.windowId !== undefined) list = list.filter((t) => t.windowId === q.windowId);
        return structuredClone(list);
      },
      get: async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return structuredClone(t);
      },
      update: async (id: number, props: Partial<MockTab>) => {
        const t = tabs.get(id);
        if (t) Object.assign(t, props);
        return t;
      },
      create: async (props: Partial<MockTab>) => {
        const id = Math.max(0, ...tabs.keys()) + 1;
        const t = { id, windowId: 1, ...props } as MockTab;
        tabs.set(id, t);
        return t;
      },
      remove: async (ids: number | number[]) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) tabs.delete(id);
      },
      discard: async () => undefined,
      onCreated: new ChromeEvent(),
      onUpdated: new ChromeEvent(),
      onRemoved: new ChromeEvent(),
      onActivated: new ChromeEvent(),
      onMoved: new ChromeEvent(),
      onAttached: new ChromeEvent(),
      onDetached: new ChromeEvent(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: async () => ({ id: 1 }),
      update: async () => undefined,
      onFocusChanged: new ChromeEvent(),
      onCreated: new ChromeEvent(),
      onRemoved: new ChromeEvent(),
    },
    tabGroups: {
      query: async () => [],
      onCreated: new ChromeEvent(),
      onUpdated: new ChromeEvent(),
      onRemoved: new ChromeEvent(),
    },
    idle: {
      setDetectionInterval: () => undefined,
      queryState: async () => 'active',
      onStateChanged: new ChromeEvent(),
    },
    alarms: {
      create: (name: string, info: { periodInMinutes?: number }) => {
        alarms.set(name, { name, ...info });
      },
      get: async (name: string) => alarms.get(name),
      getAll: async () => [...alarms.values()],
      clear: async (name: string) => alarms.delete(name),
      onAlarm: new ChromeEvent(),
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => {
        badge.text = text;
      },
      setBadgeBackgroundColor: async ({ color }: { color: string }) => {
        badge.color = color;
      },
      onClicked: new ChromeEvent(),
    },
    history: { search: async () => [] },
    topSites: { get: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
  };

  return { chrome, tabs, alarms, badge, counters };
}
