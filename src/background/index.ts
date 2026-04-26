import { db, extractDomain } from '../shared/db';
import type { OpenSource, TabEvent, TabRuntimeState } from '../shared/types';
import {
  decayAndPrune,
  getDomainStats,
  updateCooccurrenceForOpen,
  updateOnEvent,
} from '../ml/aggregate';
import { trainImplicitCleanup } from '../ml/cleanup';
import { trainEmbeddingBatch } from '../ml/embedding-train';
import { trainImplicitOpen } from '../ml/recommend';
import { buildCleanupFeatures } from '../ml/features';
import { setLastAggregateAt } from '../ml/persistence';
import { registerMessaging } from './messaging';
import {
  deleteTabState,
  getFocusedTabId,
  getIdleState,
  getStateMap,
  getTabState,
  setFocusedTabId,
  setIdleState,
  setTabState,
} from './state';

const IDLE_DETECTION_SECONDS = 60;

function nowParts(): { ts: number; hourOfDay: number; dayOfWeek: number } {
  const ts = Date.now();
  const d = new Date(ts);
  return { ts, hourOfDay: d.getHours(), dayOfWeek: d.getDay() };
}

async function logEvent(partial: Omit<TabEvent, 'ts' | 'hourOfDay' | 'dayOfWeek'>): Promise<void> {
  const stamp = nowParts();
  const event: TabEvent = { ...partial, ...stamp };
  try {
    await db.events.add(event);
    await updateOnEvent(event);
    if ((event.type === 'open' || event.type === 'navigate') && event.domain) {
      await updateCooccurrenceForOpen(event.domain, event.ts);
      await trainImplicitOpen(event);
    }
  } catch (err) {
    console.error('[chromehomepage] failed to log event', err, event);
  }
}

function isTrackable(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith('chrome://')) return false;
  if (url.startsWith('chrome-extension://')) return false;
  if (url.startsWith('edge://') || url.startsWith('about:')) return false;
  return true;
}

function classifyOpenSource(tab: chrome.tabs.Tab): OpenSource {
  if (tab.openerTabId !== undefined) return 'link';
  if (tab.url && /^https:\/\/(www\.)?(google|bing|duckduckgo)\./.test(tab.url)) return 'search';
  return 'direct';
}

function freshState(tab: chrome.tabs.Tab, ts: number): TabRuntimeState {
  return {
    tabId: tab.id ?? -1,
    url: tab.url ?? '',
    domain: extractDomain(tab.url),
    title: tab.title,
    openedAt: ts,
    focusMs: 0,
    focusCount: 0,
    pinned: tab.pinned ?? false,
    groupId: tab.groupId ?? -1,
  };
}

async function endFocusSegment(tabId: number, ts: number): Promise<void> {
  const state = await getTabState(tabId);
  if (!state || state.focusedAt === undefined) return;
  const idle = await getIdleState();
  const segment = idle === 'active' ? Math.max(0, ts - state.focusedAt) : 0;
  await setTabState({
    ...state,
    focusedAt: undefined,
    focusMs: state.focusMs + segment,
  });
  await logEvent({
    type: 'blur',
    tabId,
    url: state.url,
    domain: state.domain,
    title: state.title,
    focusMs: segment,
  });
}

async function startFocusSegment(tabId: number, ts: number, prevTabId?: number): Promise<void> {
  const state = await getTabState(tabId);
  if (!state) return;
  await setTabState({
    ...state,
    focusedAt: ts,
    focusCount: state.focusCount + 1,
  });
  await logEvent({
    type: 'focus',
    tabId,
    url: state.url,
    domain: state.domain,
    title: state.title,
    prevTabId,
  });
}

async function reconcileOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const map = await getStateMap();
  const ts = Date.now();
  const seen = new Set<number>();
  for (const tab of tabs) {
    if (tab.id === undefined || !isTrackable(tab.url)) continue;
    seen.add(tab.id);
    if (!map[tab.id]) {
      await setTabState(freshState(tab, ts));
    } else {
      // Sync any flag changes (pinned/grouped) we may have missed while sleeping.
      await setTabState({
        ...map[tab.id],
        pinned: tab.pinned ?? map[tab.id].pinned,
        groupId: tab.groupId ?? map[tab.id].groupId,
        title: tab.title ?? map[tab.id].title,
      });
    }
  }
  for (const idStr of Object.keys(map)) {
    const id = Number(idStr);
    if (!seen.has(id)) await deleteTabState(id);
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id !== undefined) {
    await setFocusedTabId(active.id);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
  chrome.alarms.create('heartbeat', { periodInMinutes: 5 });
  chrome.alarms.create('nightlyDecay', { periodInMinutes: 60 * 6 });
  chrome.alarms.create('embeddingRetrain', { periodInMinutes: 60 * 12 });
  await reconcileOpenTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
  await reconcileOpenTabs();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'nightlyDecay') {
    const now = Date.now();
    await decayAndPrune(now);
    await setLastAggregateAt(now);
  } else if (alarm.name === 'embeddingRetrain') {
    await trainEmbeddingBatch();
  }
});

registerMessaging();

// Clicking the toolbar icon should open the dashboard. If it's already open
// somewhere, focus that tab instead of stacking duplicates.
chrome.action.onClicked.addListener(async () => {
  const dashboardUrl = chrome.runtime.getURL('src/dashboard/index.html');
  const allTabs = await chrome.tabs.query({});
  const existing = allTabs.find(
    (t) =>
      t.url === dashboardUrl ||
      t.pendingUrl === dashboardUrl ||
      t.url === 'chrome://newtab/',
  );
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({});
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id === undefined || !isTrackable(tab.url)) return;
  const ts = Date.now();
  const state = freshState(tab, ts);
  await setTabState(state);
  await logEvent({
    type: 'open',
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    domain: state.domain,
    title: tab.title,
    openedFrom: classifyOpenSource(tab),
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Always sync flag/title changes to runtime state, even before page load completes.
  if (changeInfo.pinned !== undefined || changeInfo.groupId !== undefined || changeInfo.title) {
    const prev = await getTabState(tabId);
    if (prev) {
      await setTabState({
        ...prev,
        pinned: changeInfo.pinned ?? prev.pinned,
        groupId: changeInfo.groupId ?? prev.groupId,
        title: changeInfo.title ?? prev.title,
      });
    }
  }

  if (changeInfo.status !== 'complete') return;
  if (!isTrackable(tab.url)) return;
  const prev = await getTabState(tabId);
  const newDomain = extractDomain(tab.url);
  const url = tab.url ?? '';
  const title = tab.title ?? prev?.title;
  if (prev && (prev.url !== url || prev.domain !== newDomain)) {
    await setTabState({
      ...prev,
      url,
      domain: newDomain,
      title,
      pinned: tab.pinned ?? prev.pinned,
      groupId: tab.groupId ?? prev.groupId,
    });
    await logEvent({
      type: 'navigate',
      tabId,
      windowId: tab.windowId,
      url,
      domain: newDomain,
      title,
    });
  } else if (prev && title && prev.title !== title) {
    // URL didn't change but the title did — keep state title fresh; no event.
    await setTabState({ ...prev, title });
  } else if (!prev) {
    await setTabState(freshState(tab, Date.now()));
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const ts = Date.now();
  const state = await getTabState(tabId);
  const focused = await getFocusedTabId();
  if (focused === tabId) {
    await endFocusSegment(tabId, ts);
    await setFocusedTabId(undefined);
  }
  const final = await deleteTabState(tabId);
  if (!state) return;

  await logEvent({
    type: 'close',
    tabId,
    url: state.url,
    domain: state.domain,
    title: state.title,
    durationMs: ts - state.openedAt,
    focusMs: final?.focusMs ?? state.focusMs,
    focusCount: final?.focusCount ?? state.focusCount,
  });

  // Implicit cleanup label: only when the user closed the tab explicitly,
  // not when the whole window was being torn down.
  if (!removeInfo.isWindowClosing && state.domain) {
    const stats = await getDomainStats(state.domain);
    const features = buildCleanupFeatures({
      tab: {
        id: tabId,
        url: state.url,
        title: state.title,
        pinned: state.pinned,
        active: false,
        groupId: state.groupId,
      } as chrome.tabs.Tab,
      state: { ...state, focusMs: final?.focusMs ?? state.focusMs },
      stats,
      sameDomainOpenCount: 1,
      now: ts,
    });
    await trainImplicitCleanup({ features, domain: state.domain, closedByUser: true });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const ts = Date.now();
  const prev = await getFocusedTabId();
  if (prev !== undefined && prev !== tabId) {
    await endFocusSegment(prev, ts);
  }
  await setFocusedTabId(tabId);
  await startFocusSegment(tabId, ts, prev);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const ts = Date.now();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    const prev = await getFocusedTabId();
    if (prev !== undefined) {
      await endFocusSegment(prev, ts);
      await setFocusedTabId(undefined);
    }
    return;
  }
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (active?.id !== undefined) {
    const prev = await getFocusedTabId();
    if (prev !== active.id) {
      if (prev !== undefined) await endFocusSegment(prev, ts);
      await setFocusedTabId(active.id);
      await startFocusSegment(active.id, ts, prev);
    }
  }
});

chrome.idle.onStateChanged.addListener(async (state) => {
  const ts = Date.now();
  const prev = await getIdleState();
  await setIdleState(state);
  await logEvent({
    type:
      state === 'active' ? 'idle_active' : state === 'idle' ? 'idle_idle' : 'idle_locked',
    meta: { previous: prev },
  });
  if (prev === 'active' && state !== 'active') {
    const focused = await getFocusedTabId();
    if (focused !== undefined) {
      await endFocusSegment(focused, ts);
    }
  } else if (prev !== 'active' && state === 'active') {
    const focused = await getFocusedTabId();
    if (focused !== undefined) {
      const tabState = await getTabState(focused);
      if (tabState) {
        await setTabState({ ...tabState, focusedAt: ts });
      }
    }
  }
});
