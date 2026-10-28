// Refresh plumbing shared by every live surface on the dashboard.
//
// The dashboard is the new-tab page, so a heavy tab user has many copies of
// it sitting in background tabs. Before this module each copy listened to
// every chrome.tabs event (onUpdated fires several times per page load —
// status, title, favicon) and re-ran recommend.open / cleanup / pin rerank
// RPCs against the service worker. N hidden dashboards × M tab events was a
// steady SW load for pages nobody was looking at.
//
// Rules now:
//   - a hidden dashboard does no work; it remembers it is stale and
//     refreshes once when it becomes visible again;
//   - bursts of tab events collapse into one refresh (debounced);
//   - polls pause while hidden;
//   - surfaces that need the same RPC share one in-flight result.

import type { OpenCandidate } from '../shared/types';
import { fetchOpenRecommendations } from './api/recommendations';

export type TabEventName =
  | 'created'
  | 'removed'
  | 'updated'
  | 'moved'
  | 'activated'
  | 'attached'
  | 'detached';

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function addTabListener(name: TabEventName, fn: () => void): () => void {
  const tabs = typeof chrome !== 'undefined' ? chrome.tabs : undefined;
  if (!tabs) return () => undefined;
  const ev = {
    created: tabs.onCreated,
    removed: tabs.onRemoved,
    updated: tabs.onUpdated,
    moved: tabs.onMoved,
    activated: tabs.onActivated,
    attached: tabs.onAttached,
    detached: tabs.onDetached,
  }[name] as chrome.events.Event<() => void> | undefined;
  if (!ev) return () => undefined;
  ev.addListener(fn);
  return () => ev.removeListener(fn);
}

// onUpdated fires for loading spinners and audio state too; only these
// properties change anything a dashboard surface shows or scores.
const MEANINGFUL_UPDATE = ['url', 'title', 'favIconUrl', 'pinned', 'discarded', 'groupId'];

// Subscribe `refresh` to tab activity. Debounced, and deferred to the next
// visible moment when the page is hidden. Returns an unsubscribe function.
export function onTabActivity(
  refresh: () => void,
  opts: { events: TabEventName[]; delayMs?: number },
): () => void {
  const delay = opts.delayMs ?? 300;
  let timer: number | null = null;
  let staleWhileHidden = false;

  const fire = () => {
    timer = null;
    if (!isVisible()) {
      staleWhileHidden = true;
      return;
    }
    refresh();
  };
  const trigger = () => {
    if (!isVisible()) {
      staleWhileHidden = true;
      return;
    }
    if (timer !== null) return;
    timer = window.setTimeout(fire, delay);
  };
  const onUpdated = (_id: number, change: chrome.tabs.TabChangeInfo) => {
    if (MEANINGFUL_UPDATE.some((k) => k in change)) trigger();
  };
  const onVisibility = () => {
    if (isVisible() && staleWhileHidden) {
      staleWhileHidden = false;
      refresh();
    }
  };

  const offs = opts.events.map((name) =>
    name === 'updated'
      ? addTabListener(name, onUpdated as unknown as () => void)
      : addTabListener(name, trigger),
  );
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    offs.forEach((off) => off());
    document.removeEventListener('visibilitychange', onVisibility);
    if (timer !== null) window.clearTimeout(timer);
  };
}

// setInterval that skips ticks while hidden and catches up once on return
// if at least one interval elapsed. Returns a stop function.
export function visiblePoll(fn: () => void, intervalMs: number): () => void {
  let last = Date.now();
  const tick = () => {
    if (!isVisible()) return;
    last = Date.now();
    fn();
  };
  const handle = window.setInterval(tick, intervalMs);
  const onVisibility = () => {
    if (isVisible() && Date.now() - last >= intervalMs) tick();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.clearInterval(handle);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

// Suggestions and OracleHint both want recommend.open on page load. One
// SW round-trip serves both: concurrent callers share the in-flight promise,
// and a result younger than SHARE_MS is reused.
const SHARE_MS = 1500;
let shared: { at: number; p: Promise<OpenCandidate[]> } | null = null;

export function sharedOpenRecommendations(opts: { fresh?: boolean } = {}): Promise<OpenCandidate[]> {
  const now = Date.now();
  if (!opts.fresh && shared && now - shared.at < SHARE_MS) return shared.p;
  const p = fetchOpenRecommendations().catch(() => [] as OpenCandidate[]);
  shared = { at: now, p };
  return p;
}

// Resolves when the page is (or becomes) visible. Used to delay
// impression-type side effects for dashboards preloaded in the background.
export function whenVisible(): Promise<void> {
  if (isVisible()) return Promise.resolve();
  return new Promise((resolve) => {
    const on = () => {
      if (!isVisible()) return;
      document.removeEventListener('visibilitychange', on);
      resolve();
    };
    document.addEventListener('visibilitychange', on);
  });
}
