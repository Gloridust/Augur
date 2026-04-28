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
import {
  getSequenceMemory,
  invalidateForestCache,
  trainImplicitOpen,
} from '../ml/recommend';
import { trainRecommendForest } from '../ml/rf-train';
import { buildCleanupFeatures } from '../ml/features';
import {
  saveSequenceMemory,
  setLastAggregateAt,
} from '../ml/persistence';
import { bootstrapFromHistory } from '../ml/history-bootstrap';
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

// Rolling buffer of the last K focused domains, oldest → newest. Stored
// in chrome.storage.session so it survives across SW sleep cycles within
// a browser session. Used by:
//   - DomainSequenceMemory: trained on each focus transition (history → next)
//   - recommendOpen: passed as `focusHistory` so the three sequence-memory
//     predictors (short / long / time) can score candidates with context
//   - trainImplicitOpen: ditto, but for online training on each open event
const FOCUS_HISTORY_KEY = 'augur:focusHistory';
const FOCUS_HISTORY_MAX = 8;

async function getFocusHistory(): Promise<string[]> {
  const out = await chrome.storage.session.get(FOCUS_HISTORY_KEY);
  const v = out[FOCUS_HISTORY_KEY];
  return Array.isArray(v) ? (v as string[]) : [];
}

async function pushFocusHistory(domain: string): Promise<string[]> {
  if (!domain) return getFocusHistory();
  let seq = await getFocusHistory();
  // Dedupe consecutive identical focuses — toggling away and back to
  // the same tab shouldn't fill the buffer with one repeated domain.
  if (seq.length > 0 && seq[seq.length - 1] === domain) return seq;
  seq = [...seq, domain];
  if (seq.length > FOCUS_HISTORY_MAX) seq = seq.slice(-FOCUS_HISTORY_MAX);
  await chrome.storage.session.set({ [FOCUS_HISTORY_KEY]: seq });
  return seq;
}

// Train the sequence memory on a (history → next) transition. The history
// is the buffer state BEFORE the new domain was pushed.
async function observeSequenceTransition(
  prevHistory: string[],
  next: string,
  ts: number,
): Promise<void> {
  if (!next) return;
  if (prevHistory.length === 0) return;
  const seq = await getSequenceMemory();
  const hour = new Date(ts).getHours();
  seq.observe(prevHistory, next, ts, hour);
  await saveSequenceMemory(seq);
}

function nowParts(): { ts: number; hourOfDay: number; dayOfWeek: number } {
  const ts = Date.now();
  const d = new Date(ts);
  return { ts, hourOfDay: d.getHours(), dayOfWeek: d.getDay() };
}

async function buildOpenContext(): Promise<{
  focusHistory: string[];
  focusedDomain?: string;
  openDomains: string[];
}> {
  const focusHistory = await getFocusHistory();
  const focusedTabId = await getFocusedTabId();
  const stateMap = await getStateMap();
  const focusedDomain =
    focusedTabId !== undefined ? stateMap[focusedTabId]?.domain : undefined;
  const openDomains = Object.values(stateMap)
    .map((s) => s.domain)
    .filter((d): d is string => !!d);
  return { focusHistory, focusedDomain, openDomains };
}

async function logEvent(partial: Omit<TabEvent, 'ts' | 'hourOfDay' | 'dayOfWeek'>): Promise<void> {
  const stamp = nowParts();
  const event: TabEvent = { ...partial, ...stamp };
  try {
    await db.events.add(event);
    await updateOnEvent(event);
    if ((event.type === 'open' || event.type === 'navigate') && event.domain) {
      await updateCooccurrenceForOpen(event.domain, event.ts);
      // Pass real context so trainImplicitOpen can compute meaningful
      // embedSim / seqProb / openDomains features at training time. The
      // pre-fix call sent `focusedDomain: undefined` and `openDomains: []`,
      // which collapsed every implicit positive into context-free noise.
      const ctx = await buildOpenContext();
      await trainImplicitOpen(event, ctx);
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
    navigationCount: 0,
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
  // Sequence-memory bookkeeping. The buffer state BEFORE we push is the
  // "history" that led to this focus — train on (history → state.domain),
  // then push so subsequent transitions see the latest position.
  if (state.domain && isTrackable(state.url)) {
    const prevHistory = await getFocusHistory();
    await observeSequenceTransition(prevHistory, state.domain, ts);
    await pushFocusHistory(state.domain);
  }
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

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
  chrome.alarms.create('heartbeat', { periodInMinutes: 5 });
  // `delayInMinutes` makes the first fire happen soon after install/update,
  // not after a full period — without it, embedding waits 12h and forest
  // waits 8h before their first training pass, which is awful for fresh
  // installs that just ran the history bootstrap and have plenty of data
  // to learn from immediately.
  chrome.alarms.create('nightlyDecay', { delayInMinutes: 30, periodInMinutes: 60 * 6 });
  chrome.alarms.create('embeddingRetrain', { delayInMinutes: 5, periodInMinutes: 60 * 12 });
  // Random Forest batch retrain. The OnlineLogReg keeps absorbing live
  // feedback in between; the forest captures non-linear feature
  // interactions and gives the recommender a stable second opinion on
  // each candidate. See src/ml/rf-train.ts.
  chrome.alarms.create('forestRetrain', { delayInMinutes: 3, periodInMinutes: 60 * 8 });
  await reconcileOpenTabs();

  if (details.reason === 'install') {
    // First install — seed db.events from the user's existing browser
    // history so the model has a real distribution to learn from on day
    // one (instead of waiting days for live tab events to accumulate).
    // Async + non-blocking: extension is usable immediately; aggregates
    // populate as the bootstrap finishes in the background.
    void bootstrapFromHistory().then((r) => {
      if (!r.skipped) {
        console.log(
          `[augur] history bootstrap: ${r.events} events across ${r.domains} domains`,
        );
      }
    });
  } else if (details.reason === 'update') {
    // Clean up KV keys orphaned by past schema bumps. Adding to this list
    // is safe — bulkDelete silently ignores keys that don't exist.
    const STALE_KEYS = [
      'model:cleanup:v2',
      'model:cleanup:v3', // bumped to v4 when cluster features were added
      'model:recommend:v2',
      'model:recommend:v3', // bumped to v4 when seqProbShort/Long/Time were added
    ];
    let staleDeleted = 0;
    try {
      const existing = await db.kv.bulkGet(STALE_KEYS);
      staleDeleted = existing.filter((v) => v !== undefined).length;
      await db.kv.bulkDelete(STALE_KEYS);
    } catch {
      // ignore — kv table may not be ready yet on first SW boot
    }

    // Schema bump or undertrained model → replay implicit training from
    // existing events so the LR has realistic weights immediately, instead
    // of forcing the user to wait days for organic events to retrain it.
    // Also fits the forest. Runs async / non-blocking — recommendations
    // return immediately with a warming model.
    //
    // Without this, surfaces gated on model confidence (OracleHint at
    // ≥0.55, smart-cleanup auto-select at ≥0.60) silently disappear after
    // every model version bump until enough live events accumulate.
    //
    // The `warmupRecommendIfNeeded` helper internally checks the model's
    // trained-sample count, so it's safe to call unconditionally — it
    // no-ops if the model is already mature.
    void warmupRecommendIfNeeded();
    void (staleDeleted); // silence unused-var lint; kept above for telemetry
  }
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
  await reconcileOpenTabs();
  // If the recommend LR is undertrained (< 100 samples) and we have plenty
  // of events to learn from, replay implicit training once. Covers the
  // case where a previous schema bump reset the model but the user got the
  // new build BEFORE the auto-warmup logic existed — without this, surfaces
  // gated on confidence stay dark forever.
  void warmupRecommendIfNeeded();
});

const WARMUP_MIN_SAMPLES = 100;
const WARMUP_MIN_EVENTS = 200;
let warmupAttempted = false;

async function warmupRecommendIfNeeded(): Promise<void> {
  if (warmupAttempted) return;
  warmupAttempted = true;
  try {
    const recRow = await db.kv.get('model:recommend:v4');
    const rec = recRow?.value as { trainedSamples?: number } | undefined;
    const trained = rec?.trainedSamples ?? 0;
    if (trained >= WARMUP_MIN_SAMPLES) return;
    const eventCount = await db.events.count();
    if (eventCount < WARMUP_MIN_EVENTS) return;

    const { replayImplicitTraining, trainRecommendForest } = await import(
      '../ml/rf-train'
    );
    const { invalidateForestCache } = await import('../ml/recommend');
    const replayResult = await replayImplicitTraining();
    const forestResult = await trainRecommendForest();
    invalidateForestCache();
    console.log(
      `[augur] LR warmup: ${trained} → ${trained + replayResult.openSamples * 6} samples; forest=${forestResult.trained}`,
    );
  } catch (err) {
    console.error('[augur] LR warmup failed', err);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'nightlyDecay') {
    const now = Date.now();
    await decayAndPrune(now);
    await setLastAggregateAt(now);
  } else if (alarm.name === 'embeddingRetrain') {
    await trainEmbeddingBatch();
  } else if (alarm.name === 'forestRetrain') {
    try {
      const r = await trainRecommendForest();
      if (r.trained > 0) {
        invalidateForestCache();
        console.log(
          `[augur] forest retrain: ${r.trained} samples (${r.posSamples} pos, ${r.negSamples} neg)`,
        );
      }
    } catch (err) {
      console.error('[augur] forest retrain failed', err);
    }
  }
});

registerMessaging();

// Clicking the toolbar icon opens the dashboard via a normal URL navigation
// — that's the only way to escape Chrome's "new tab" context (the bottom
// "myHomepage / Customize Chrome" strip only appears for tabs opened *as*
// the new tab). If a dashboard tab already exists, focus it; if it was
// opened via Cmd+T (with the strip), reload it via direct URL to drop the
// strip.
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
    await chrome.tabs.update(existing.id, { active: true, url: dashboardUrl });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: dashboardUrl });
});

// Newtab interceptor — see manifest comment. Any time Chrome creates a tab
// pointing at chrome://newtab/, we immediately rewrite it to the dashboard
// URL. Because the rewrite happens before Chrome assigns the newtab role,
// the "Customize Chrome / extension name" footer strip never attaches.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined) return;
  const url = tab.url ?? tab.pendingUrl ?? '';
  if (url === 'chrome://newtab/' || url === 'chrome://new-tab-page/') {
    const dashboardUrl = chrome.runtime.getURL('src/dashboard/index.html');
    chrome.tabs.update(tab.id, { url: dashboardUrl }).catch(() => {
      /* tab may already be gone */
    });
  }
});

// Safety net: also catch tabs that update INTO chrome://newtab/ later.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === 'chrome://newtab/' || changeInfo.url === 'chrome://new-tab-page/') {
    const dashboardUrl = chrome.runtime.getURL('src/dashboard/index.html');
    chrome.tabs.update(tabId, { url: dashboardUrl }).catch(() => {
      /* tab may already be gone */
    });
  }
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

  // Log every distinct state transition Chrome reports — pin, audible,
  // muted, discarded, group membership. These are otherwise lost to the
  // events table and unrecoverable for future model training. Each event
  // captures the full tab snapshot via meta.snapshot so analyses can
  // reconstruct context post-hoc.
  if (changeInfo.pinned !== undefined && tab.url) {
    await logEvent({
      type: changeInfo.pinned ? 'tab_pinned' : 'tab_unpinned',
      tabId,
      windowId: tab.windowId,
      url: tab.url,
      domain: extractDomain(tab.url),
      title: tab.title,
      pinned: changeInfo.pinned,
      tabIndex: tab.index,
    });
  }
  if (changeInfo.audible !== undefined && tab.url && isTrackable(tab.url)) {
    await logEvent({
      type: changeInfo.audible ? 'tab_audible_start' : 'tab_audible_end',
      tabId,
      windowId: tab.windowId,
      url: tab.url,
      domain: extractDomain(tab.url),
      title: tab.title,
      audible: changeInfo.audible,
    });
  }
  if (changeInfo.mutedInfo !== undefined && tab.url && isTrackable(tab.url)) {
    await logEvent({
      type: changeInfo.mutedInfo.muted ? 'tab_muted' : 'tab_unmuted',
      tabId,
      windowId: tab.windowId,
      url: tab.url,
      domain: extractDomain(tab.url),
      muted: changeInfo.mutedInfo.muted,
      meta: { reason: changeInfo.mutedInfo.reason },
    });
  }
  if (changeInfo.discarded !== undefined && tab.url && isTrackable(tab.url)) {
    await logEvent({
      type: changeInfo.discarded ? 'tab_discarded' : 'tab_undiscarded',
      tabId,
      windowId: tab.windowId,
      url: tab.url,
      domain: extractDomain(tab.url),
      discarded: changeInfo.discarded,
    });
  }
  if (changeInfo.groupId !== undefined && tab.url && isTrackable(tab.url)) {
    await logEvent({
      type: changeInfo.groupId >= 0 ? 'tab_grouped' : 'tab_ungrouped',
      tabId,
      windowId: tab.windowId,
      url: tab.url,
      domain: extractDomain(tab.url),
      groupId: changeInfo.groupId,
    });
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
      navigationCount: (prev.navigationCount ?? 0) + 1,
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
    // First time we see this tab AS a tracked URL. `chrome.tabs.onCreated`
    // fired earlier with no URL (Chrome's standard sequence: create blank
    // tab → navigate → load complete), so the create-time isTrackable
    // check returned early and no 'open' event was logged. Log it now —
    // otherwise db.events accumulates only 'navigate' events and the
    // today recap's `tabsOpened` count stays stuck at 0.
    await setTabState(freshState(tab, Date.now()));
    await logEvent({
      type: 'open',
      tabId,
      windowId: tab.windowId,
      url,
      domain: newDomain,
      title,
      openedFrom: classifyOpenSource(tab),
    });
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

// ── Tab move + attach/detach (cross-window moves) ──────────────────
// chrome.tabs.onMoved fires for in-window reorders; onAttached / onDetached
// fire for cross-window drags. None of these are inferable from onUpdated.
chrome.tabs.onMoved.addListener(async (tabId, info) => {
  const state = await getTabState(tabId);
  await logEvent({
    type: 'tab_moved',
    tabId,
    windowId: info.windowId,
    url: state?.url,
    domain: state?.domain,
    title: state?.title,
    tabIndex: info.toIndex,
    meta: { fromIndex: info.fromIndex, toIndex: info.toIndex },
  });
});

chrome.tabs.onAttached.addListener(async (tabId, info) => {
  const state = await getTabState(tabId);
  await logEvent({
    type: 'tab_attached',
    tabId,
    windowId: info.newWindowId,
    url: state?.url,
    domain: state?.domain,
    tabIndex: info.newPosition,
    meta: { newWindowId: info.newWindowId, newPosition: info.newPosition },
  });
});

chrome.tabs.onDetached.addListener(async (tabId, info) => {
  const state = await getTabState(tabId);
  await logEvent({
    type: 'tab_detached',
    tabId,
    windowId: info.oldWindowId,
    url: state?.url,
    domain: state?.domain,
    tabIndex: info.oldPosition,
    meta: { oldWindowId: info.oldWindowId, oldPosition: info.oldPosition },
  });
});

// ── Tab-group lifecycle ─────────────────────────────────────────────
// Capture group create/update/remove so future models can reconstruct
// "user organized N tabs into a group named X at time T". Otherwise
// derivable only from periodic snapshots, which we don't take.
if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener(async (group) => {
    await logEvent({
      type: 'group_created',
      windowId: group.windowId,
      groupId: group.id,
      groupTitle: group.title,
      meta: { color: group.color, collapsed: group.collapsed },
    });
  });
  chrome.tabGroups.onUpdated.addListener(async (group) => {
    await logEvent({
      type: 'group_updated',
      windowId: group.windowId,
      groupId: group.id,
      groupTitle: group.title,
      meta: { color: group.color, collapsed: group.collapsed },
    });
  });
  chrome.tabGroups.onRemoved.addListener(async (group) => {
    await logEvent({
      type: 'group_removed',
      windowId: group.windowId,
      groupId: group.id,
      groupTitle: group.title,
    });
  });
}

// ── Window lifecycle ────────────────────────────────────────────────
// onCreated fires when the user spawns a new window; onRemoved when one
// closes (even if it had open tabs that get tracked individually).
chrome.windows.onCreated.addListener(async (window) => {
  await logEvent({
    type: 'window_created',
    windowId: window.id,
    meta: {
      type: window.type,
      state: window.state,
      incognito: window.incognito,
    },
  });
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await logEvent({
    type: 'window_removed',
    windowId,
  });
});

// We already react to onFocusChanged for state-management purposes (see
// above). Here we ALSO log it as an event — useful for reconstructing
// "which window was the user actually looking at" for cleanup-feature
// post-hoc analysis.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await logEvent({
    type: 'window_focus_changed',
    windowId: windowId === chrome.windows.WINDOW_ID_NONE ? undefined : windowId,
    meta: { lostFocus: windowId === chrome.windows.WINDOW_ID_NONE },
  });
});
