import { db, extractDomain, MAINTENANCE_REBUILD_KEY } from '../shared/db';
import type { OpenSource, TabEvent, TabRuntimeState } from '../shared/types';
import {
  decayAndPrune,
  getDomainStats,
  rebuildFromEvents,
  updateCooccurrenceForOpen,
  updateOnEvent,
} from '../ml/aggregate';
import { outcomeFeatures, trainCleanupOutcome } from '../ml/cleanup';
import { trainEmbeddingBatch } from '../ml/embedding-train';
import {
  invalidateForestCache,
  nudgeRecommendOnClose,
  observeFocusTransition,
  trainImplicitOpen,
} from '../ml/recommend';
import { replayImplicitTraining, trainRecommendForest } from '../ml/rf-train';
import { idleMsOf } from '../ml/features';
import { RECOMMEND_MODEL_VERSION, setLastAggregateAt } from '../ml/persistence';
import { bumpCircadian, decayCircadian } from '../ml/circadian';
import { bumpUrlPrefix, pruneUrlPrefixes } from '../ml/urlprefix';
import { observeDomainText, pruneDomainText } from '../ml/domaintext';
import { trainBlendCalib } from '../ml/blendcalib';
import { bootstrapFromHistory } from '../ml/history-bootstrap';
import { flushAll } from '../ml/flush';
import { logError } from '../shared/errorlog';
import { registerMessaging } from './messaging';
import { enqueue } from './queue';
import {
  deleteTabState,
  flushState,
  getFocusedTabId,
  getIdleState,
  getStateMap,
  getTabState,
  replaceStateMap,
  setFocusedTabId,
  setIdleState,
  setTabState,
  type StateMap,
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

// In memory for this SW lifetime, written through to storage.session (the
// dashboard RPC context builder reads it from there).
let focusHistoryCache: string[] | null = null;

async function getFocusHistory(): Promise<string[]> {
  if (!focusHistoryCache) {
    const out = await chrome.storage.session.get(FOCUS_HISTORY_KEY);
    const v = out[FOCUS_HISTORY_KEY];
    focusHistoryCache = Array.isArray(v) ? (v as string[]) : [];
  }
  return focusHistoryCache;
}

async function pushFocusHistory(domain: string): Promise<void> {
  if (!domain) return;
  const seq = await getFocusHistory();
  // Dedupe consecutive identical focuses — toggling away and back to
  // the same tab shouldn't fill the buffer with one repeated domain.
  if (seq.length > 0 && seq[seq.length - 1] === domain) return;
  focusHistoryCache = [...seq, domain].slice(-FOCUS_HISTORY_MAX);
  await chrome.storage.session.set({ [FOCUS_HISTORY_KEY]: focusHistoryCache });
}

function nowParts(): { ts: number; hourOfDay: number; dayOfWeek: number } {
  const ts = Date.now();
  const d = new Date(ts);
  return { ts, hourOfDay: d.getHours(), dayOfWeek: d.getDay() };
}

const SESSION_GAP_MS = 30 * 60 * 1000;
// 2 min (was 15) — see the switch-filter note in recommend.ts. Only filters
// rapid duplicate opens; legitimate returns to a recently-used domain now count.
const RECENT_FOCUS_MS = 2 * 60 * 1000;
const SESSION_KEY = 'augur:session'; // { startTs, lastEventTs }

let sessionCache: { startTs: number; lastEventTs: number } | null = null;

async function touchSession(now: number): Promise<number> {
  if (!sessionCache) {
    const out = await chrome.storage.session.get(SESSION_KEY);
    sessionCache =
      (out[SESSION_KEY] as { startTs: number; lastEventTs: number } | undefined) ?? {
        startTs: now,
        lastEventTs: now,
      };
  }
  if (now - sessionCache.lastEventTs > SESSION_GAP_MS) sessionCache.startTs = now; // new session after a gap
  sessionCache.lastEventTs = now;
  await chrome.storage.session.set({ [SESSION_KEY]: sessionCache });
  return sessionCache.startTs;
}

// Domains focused/opened/navigated within the last RECENT_FOCUS_MS — the
// switch-event filter's "recently seen" set (Phase 1.1). Must be read BEFORE
// the triggering event is written (see logEvent).
async function recentlyFocusedDomains(now: number): Promise<string[]> {
  const since = now - RECENT_FOCUS_MS;
  const rows = await db.events
    .where('ts')
    .between(since, now, true, true)
    .filter(
      (e) => e.type === 'focus' || e.type === 'open' || e.type === 'navigate',
    )
    .toArray();
  return Array.from(new Set(rows.map((e) => e.domain).filter((d): d is string => !!d)));
}

function lastRealDomain(history: string[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) if (!history[i].startsWith('chrome')) return history[i];
  return undefined;
}

async function buildOpenContext(
  now: number,
  ownTabId: number | undefined,
  sessionStartTs: number,
  eventDomain: string,
): Promise<{
  focusHistory: string[];
  focusedDomain?: string;
  openDomains: string[];
  recentlyFocusedDomains: string[];
  sessionStartTs: number;
}> {
  const stateMap = await getStateMap();
  const focusedTabId = await getFocusedTabId();
  // The context is what the user was on BEFORE this event. When the event's
  // own tab is the focused one — a new foreground tab, or a URL typed into
  // the new-tab page — the state map already shows the event's domain
  // there, which made every such open look like "the domain you're on" and
  // the trainer skipped it: live training silently missed exactly the
  // typed-in-a-new-tab moment (found by the real-Chrome e2e run). Fall back
  // to the last real domain in the focus history, as the offline walk does.
  const focusHistory = (await getFocusHistory()).filter((d) => d !== eventDomain);
  const focusedDomain =
    focusedTabId !== undefined && focusedTabId !== ownTabId
      ? stateMap[focusedTabId]?.domain
      : lastRealDomain(focusHistory);
  // Domains open in OTHER tabs (the event's own tab already shows the new
  // domain in the state map).
  const openDomains = Object.values(stateMap)
    .filter((s) => s.tabId !== ownTabId)
    .map((s) => s.domain)
    .filter((d): d is string => !!d);
  const recent = await recentlyFocusedDomains(now);
  return {
    focusHistory,
    focusedDomain,
    openDomains,
    recentlyFocusedDomains: recent,
    sessionStartTs,
  };
}

// `arrival`: for open/navigate, whether the tab landed on a NEW domain (vs a
// same-domain SPA route change). Visits, co-occurrence and the training
// context are only about arrivals; same-domain navigations are still logged.
async function logEvent(
  partial: Omit<TabEvent, 'ts' | 'hourOfDay' | 'dayOfWeek'>,
  arrival = true,
): Promise<void> {
  const stamp = nowParts();
  const event: TabEvent = { ...partial, ...stamp };
  const openLike = (event.type === 'open' || event.type === 'navigate') && !!event.domain;
  try {
    const sessionStartTs = await touchSession(event.ts);

    // LEARN FROM THE OPEN BEFORE RECORDING IT. Training must see the world
    // exactly as serving would have just before this open — no trace of the
    // open itself. Two bugs lived here:
    //   - the event was written first, so the 2-min switch filter always
    //     found it ("seen just now") and returned: from v0.3.0 no live open
    //     ever trained the model;
    //   - and even when it did, the positive's features (visited-in-the-last-
    //     30-min, recency, velocity, frecency, co-occurrence) included the
    //     open itself — a target leak.
    // A training failure must never cost us the event, so it's isolated.
    if (openLike && arrival && event.domain) {
      try {
        const ctx = await buildOpenContext(event.ts, event.tabId, sessionStartTs, event.domain);
        await trainImplicitOpen(event, ctx);
      } catch (err) {
        void logError('trainImplicitOpen', err);
      }
    }

    await db.events.add(event);
    await updateOnEvent(event, arrival);
    // Keep the personal-circadian histogram current for any tracked event.
    if (event.domain) await bumpCircadian(stamp.hourOfDay, stamp.ts);
    if (openLike && event.domain) {
      // URL-prefix table (Phase 4.3) — track the precise page, not just domain.
      await bumpUrlPrefix(event.domain, event.url, event.ts);
      // Semantic text vector — fold the page's title+URL words into the
      // domain's running-mean text embedding (the "meaning" layer).
      await observeDomainText(event.domain, event.title, event.url, event.ts);
      if (arrival) await updateCooccurrenceForOpen(event.domain, event.ts);
    }
  } catch (err) {
    void logError('logEvent', err);
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
    lastFocusedAt: ts,
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
  // Cleanup outcome: the user switched (from another tab) to one that had
  // been sitting in the background, or was never viewed → NOT a zombie.
  // Returning to the computer and refocusing the tab that was already in view
  // (prevTabId undefined after a window/idle blur) doesn't count — that tab
  // was never backgrounded. Features describe the state just before this
  // focus; the ≥30-min idle gate is inside trainCleanupOutcome.
  if (
    state.focusedAt === undefined &&
    prevTabId !== undefined &&
    prevTabId !== tabId &&
    state.domain &&
    isTrackable(state.url)
  ) {
    const stats = await getDomainStats(state.domain);
    await trainCleanupOutcome({
      features: outcomeFeatures(state, stats, ts),
      outcome: 'refocused',
    });
  }
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
  // Sequence memory + factorized transition learn from every tab switch.
  // The buffer BEFORE the push is the history that led to this focus.
  if (state.domain && isTrackable(state.url)) {
    const prevHistory = [...(await getFocusHistory())];
    await observeFocusTransition(prevHistory, state.domain, ts);
    await pushFocusHistory(state.domain);
  }
}

// ── Stale-tab badge ────────────────────────────────────────────────────────
// Toolbar-icon count of tabs the Declutter sweep would PRE-CHECK: never
// viewed (≥30 min old), or out of sight for ≥24 h. Heavy tab-hoarders live
// inside their tabs, not on the dashboard, so this is the one always-visible
// nudge. It used to count anything idle ≥2 h — but backgrounded tabs idle
// 2–6 h are refocused 98% of the time, so that number was mostly noise.
// Cheap: reads the in-memory tab-state map; idleness via the shared idleMsOf.
const STALE_BADGE_MS = 24 * 60 * 60 * 1000;
const STALE_BADGE_MIN_AGE_MS = 30 * 60 * 1000;
async function updateStaleBadge(): Promise<void> {
  try {
    if (!chrome.action?.setBadgeText) return;
    const map = await getStateMap();
    const now = Date.now();
    let stale = 0;
    for (const s of Object.values(map)) {
      if (!s || s.pinned || s.focusedAt !== undefined) continue; // pinned / in view
      if (now - s.openedAt < STALE_BADGE_MIN_AGE_MS) continue;
      if (s.focusCount === 0 || idleMsOf(s, now) >= STALE_BADGE_MS) stale++;
    }
    await chrome.action.setBadgeBackgroundColor({ color: '#D97706' });
    await chrome.action.setBadgeText({ text: stale > 0 ? String(stale) : '' });
  } catch {
    // Best-effort — chrome.action can be unavailable in some contexts.
  }
}

// Bring the runtime map in line with the tabs that actually exist. Builds the
// new map in memory and writes it ONCE (the old per-tab read-modify-write was
// O(n²): ~5 MB of storage traffic for 118 tabs, during session restore).
//
// storage.session is wiped on browser restart and extension update, so every
// hoarded tab used to come back with openedAt = now and focusCount = 0 — the
// badge and Declutter went blind for hours and every restored tab looked
// "never viewed". Adopted tabs are now seeded from Chrome's own
// tab.lastAccessed: they've been viewed before, and that's when.
async function reconcileOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const prevMap = await getStateMap();
  const ts = Date.now();
  const next: StateMap = {};
  for (const tab of tabs) {
    if (tab.id === undefined || !isTrackable(tab.url)) continue;
    const prev = prevMap[tab.id];
    if (prev) {
      // Sync flag changes (pinned/grouped/title) we may have missed while asleep.
      next[tab.id] = {
        ...prev,
        pinned: tab.pinned ?? prev.pinned,
        groupId: tab.groupId ?? prev.groupId,
        title: tab.title ?? prev.title,
      };
    } else {
      const lastAccessed = (tab as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed;
      const fresh = freshState(tab, ts);
      if (lastAccessed && lastAccessed < ts) {
        fresh.openedAt = lastAccessed;
        fresh.lastFocusedAt = lastAccessed;
        fresh.focusCount = 1;
      }
      next[tab.id] = fresh;
    }
  }
  await replaceStateMap(next);
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id !== undefined && next[active.id]) {
    await setFocusedTabId(active.id);
    if (next[active.id].focusedAt === undefined) next[active.id].focusedAt = ts;
  }
  await updateStaleBadge();
}

// Alarms survive SW restarts but not every update path; (re)create any that
// are missing. Idempotent.
async function ensureAlarms(): Promise<void> {
  const want: Array<[string, chrome.alarms.AlarmCreateInfo]> = [
    ['heartbeat', { periodInMinutes: 5 }],
    // `delayInMinutes` makes the first fire happen soon after install/update
    // instead of after a full period.
    ['nightlyDecay', { delayInMinutes: 30, periodInMinutes: 60 * 6 }],
    ['embeddingRetrain', { delayInMinutes: 5, periodInMinutes: 60 * 12 }],
    // Random Forest batch retrain — captures non-linear feature interactions
    // between the LR's online updates. See src/ml/rf-train.ts.
    ['forestRetrain', { delayInMinutes: 3, periodInMinutes: 60 * 8 }],
  ];
  for (const [name, info] of want) {
    if (!(await chrome.alarms.get(name))) chrome.alarms.create(name, info);
  }
}

// One-time maintenance flagged by the v5 schema migration (or an import):
// rebuild the derived aggregates from the cleaned event log, then retrain the
// embedding on the rebuilt co-occurrence table.
async function runPendingMaintenance(): Promise<void> {
  const flag = await db.kv.get(MAINTENANCE_REBUILD_KEY);
  if (!flag) return;
  await rebuildFromEvents();
  await trainEmbeddingBatch();
  await db.kv.delete(MAINTENANCE_REBUILD_KEY);
}

// KV keys orphaned by past schema bumps. Adding to this list is safe —
// bulkDelete ignores keys that don't exist.
const STALE_KEYS = [
  'model:cleanup:v2',
  'model:cleanup:v3', // bumped to v4 when cluster features were added
  'model:cleanup:v4', // bumped to v5: outcome labels replace the circular rule
  'model:recommend:v2',
  'model:recommend:v3', // bumped to v4 when seqProbShort/Long/Time were added
  'model:recommend:v4', // bumped to v5 when implicit-train class weights were fixed
  'model:recommend:v5', // bumped to v6 when negative-sample distribution was fixed
  'model:recommend:v6', // bumped to v7 when mixture (easy+hard) sampling landed
  'model:recommend:v7', // bumped to v8: +8 features, group-softmax, switch filter
  'model:recommend:v8', // bumped to v9: +dinAttention (30 features)
  'model:recommend:v9', // bumped to v10: isCurrentlyOpen leak removed, dedup'd data
  'model:recommend:forest:v1', // forest feature shape changed (v1 → v2)
  'model:recommend:forest:v2', // v3: newest-window training on cleaned data
  'model:recommend:mlp:v1', // v2: retrained alongside recommend v10
  'model:recommend:v10', // v11: log-scaled inputs, recency prior, lr 0.001, pool negatives
  'model:recommend:v11', // v12: lr 0.0003, prior-centred regularization
  'model:recommend:forest:v3', // v4: pool negatives, point-in-time features
  'model:recommend:mlp:v2', // v3: log-scaled inputs
  'transition:v1', // v2: was never trained past random init
];

chrome.runtime.onInstalled.addListener((details) => {
  chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
  void enqueue('onInstalled', async () => {
    await ensureAlarms();
    await reconcileOpenTabs();
    if (details.reason === 'install') {
      // First install — seed db.events from the user's existing browser
      // history so the model has a real distribution to learn from on day
      // one. Non-blocking: the extension is usable immediately.
      void bootstrapFromHistory().then((r) => {
        if (!r.skipped) {
          console.log(`[augur] history bootstrap: ${r.events} events across ${r.domains} domains`);
        }
      });
      return;
    }
    if (details.reason === 'update') {
      try {
        await db.kv.bulkDelete(STALE_KEYS);
      } catch {
        // ignore — kv table may not be ready yet on first SW boot
      }
      await runPendingMaintenance();
    }
  }).then(() => warmupModelsIfNeeded());
});

chrome.runtime.onStartup.addListener(() => {
  chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
  void enqueue('onStartup', async () => {
    await ensureAlarms();
    await reconcileOpenTabs();
    await runPendingMaintenance();
  }).then(() => warmupModelsIfNeeded());
});

const WARMUP_MIN_SAMPLES = 100;
const WARMUP_MIN_EVENTS = 200;
let warmupAttempted = false;

// Schema bump or undertrained models → replay implicit training from the
// event log (both heads), refit the forest. Runs OUTSIDE the event queue so a
// multi-second replay doesn't stall live tab tracking; the shared in-memory
// models are race-safe (promise-cached loads, additive updates).
//
// Without this, surfaces gated on model confidence (OracleHint, smart-cleanup
// auto-select) go dark after every model version bump until enough live
// events accumulate.
async function warmupModelsIfNeeded(): Promise<void> {
  if (warmupAttempted) return;
  warmupAttempted = true;
  try {
    const recRow = await db.kv.get(RECOMMEND_MODEL_VERSION);
    const trained = (recRow?.value as { trainedSamples?: number } | undefined)?.trainedSamples ?? 0;
    if (trained >= WARMUP_MIN_SAMPLES) return;
    if ((await db.events.count()) < WARMUP_MIN_EVENTS) return;

    const replay = await replayImplicitTraining();
    const forest = await trainRecommendForest();
    invalidateForestCache();
    await flushAll();
    console.log(
      `[augur] warm-up: ${replay.openSamples} open groups, ${replay.cleanupSamples} cleanup outcomes; forest=${forest.trained}`,
    );
  } catch (err) {
    void logError('warmup', err);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'nightlyDecay') {
    // Rewrites the same domain/pair rows live events update → serialize.
    void enqueue('nightlyDecay', async () => {
      const now = Date.now();
      await decayAndPrune(now);
      await decayCircadian(now);
      await pruneUrlPrefixes(now);
      await pruneDomainText(now);
      // Phase 4.2: refit the final-score calibrator from realized outcomes
      // (oracle_shown → opened-within-5min joins).
      try {
        await trainBlendCalib(now);
      } catch (err) {
        void logError('blendCalibration', err);
      }
      await setLastAggregateAt(now);
    });
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
      void logError('forestRetrain', err);
    }
  } else if (alarm.name === 'heartbeat') {
    // Refresh the stale-tab badge as tabs age into staleness between events,
    // and persist anything still pending (belt-and-braces for the timers).
    void enqueue('heartbeat', async () => {
      await updateStaleBadge();
      await flushState();
      await flushAll();
    });
  }
});

// Catch-all diagnostics: anything that escapes a try/catch (or an unhandled
// promise rejection) gets persisted to the error ring-buffer so it rides
// along in the debug bundle. Without this, SW crashes leave zero trace once
// the worker restarts — exactly what made the "document is not defined" bug
// take several releases to pin down. IndexedDB requests aborted because the
// browser is quitting are expected, not bugs — they filled the July bundle's
// errors.json and would drown real failures.
function isShutdownNoise(reason: unknown): boolean {
  const msg = reason instanceof Error ? reason.message : String(reason ?? '');
  return /browser is shutting down/i.test(msg);
}
self.addEventListener('error', (e) => {
  const reason = (e as ErrorEvent).error ?? (e as ErrorEvent).message;
  if (!isShutdownNoise(reason)) void logError('sw.onerror', reason);
});
self.addEventListener('unhandledrejection', (e) => {
  const reason = (e as PromiseRejectionEvent).reason;
  if (!isShutdownNoise(reason)) void logError('sw.unhandledrejection', reason);
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

chrome.tabs.onCreated.addListener((tab) => {
  void enqueue('tabs.onCreated', async () => {
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
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void enqueue('tabs.onUpdated', () => handleTabUpdated(tabId, changeInfo, tab));
});

async function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
): Promise<void> {
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

  // ── Fast path: URL change detection (handles SPA + full reloads) ──
  // Chrome fires onUpdated with `changeInfo.url` set whenever the tab's
  // URL changes — for full-page navigations AND for SPA pushState /
  // replaceState calls. Status only transitions to 'complete' on full
  // reloads, so the `status === 'complete'` branch below misses every
  // in-app navigation in GitHub / Gmail / Twitter / Linear / etc.
  //
  // We process changeInfo.url directly here, BEFORE the status gate.
  // Multiple onUpdated fires for the same URL (commit + complete) are
  // de-duped by the `prev.url !== changeInfo.url` check — which only works
  // because handlers run serially (./queue); when they interleaved, both
  // paths saw the old URL and 22% of navigates were logged twice.
  if (changeInfo.url && isTrackable(changeInfo.url)) {
    const prev = await getTabState(tabId);
    if (prev && prev.url !== changeInfo.url) {
      const newDomain = extractDomain(changeInfo.url);
      await setTabState({
        ...prev,
        url: changeInfo.url,
        domain: newDomain,
        title: tab.title ?? prev.title,
        pinned: tab.pinned ?? prev.pinned,
        groupId: tab.groupId ?? prev.groupId,
        navigationCount: (prev.navigationCount ?? 0) + 1,
      });
      await logEvent(
        {
          type: 'navigate',
          tabId,
          windowId: tab.windowId,
          url: changeInfo.url,
          domain: newDomain,
          title: tab.title ?? prev.title,
        },
        prev.domain !== newDomain,
      );
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
    await logEvent(
      {
        type: 'navigate',
        tabId,
        windowId: tab.windowId,
        url,
        domain: newDomain,
        title,
      },
      prev.domain !== newDomain,
    );
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
    const ts = Date.now();
    await setTabState(freshState(tab, ts));
    await logEvent({
      type: 'open',
      tabId,
      windowId: tab.windowId,
      url,
      domain: newDomain,
      title,
      openedFrom: classifyOpenSource(tab),
    });
    // The tab may ALREADY be the focused one: Cmd+T → type a URL activates
    // the tab while it's still an untracked new-tab page, so onActivated's
    // startFocusSegment found no state and did nothing. Without this, the
    // focus segment (dwell time, the tab switch itself) of every typed-URL
    // tab went unrecorded until the user switched away and back.
    if ((await getFocusedTabId()) === tabId) {
      await startFocusSegment(tabId, ts, undefined);
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void enqueue('tabs.onRemoved', () => handleTabRemoved(tabId, removeInfo));
});

async function handleTabRemoved(
  tabId: number,
  removeInfo: chrome.tabs.TabRemoveInfo,
): Promise<void> {
  const ts = Date.now();
  const state = await getTabState(tabId);
  const focused = await getFocusedTabId();
  const wasInView = focused === tabId;
  if (wasInView) {
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
    meta: { windowClosing: removeInfo.isWindowClosing },
  });

  // Cleanup outcome: a tab closed while sitting in the BACKGROUND (not the
  // one being looked at, not a whole window going away) was a zombie. The
  // ≥30-min idle gate is inside trainCleanupOutcome.
  if (!wasInView && !removeInfo.isWindowClosing && state.domain) {
    const stats = await getDomainStats(state.domain);
    await trainCleanupOutcome({
      features: outcomeFeatures(state, stats, ts),
      outcome: 'closed',
    });
  }

  // Dwell-time feedback for the recommend head: a long-dwelled open was a
  // good open (soft bandit accept); a bounce (closed in <10s, never
  // focused) was a wasted open (soft bandit ignore). Window-closing is
  // included deliberately — dwell time is meaningful regardless of HOW
  // the tab eventually closed.
  if (state.domain) {
    await nudgeRecommendOnClose({
      domain: state.domain,
      focusMs: final?.focusMs ?? state.focusMs,
      focusCount: final?.focusCount ?? state.focusCount,
    });
  }

  // Closing tabs (e.g. a Declutter sweep) should drop the badge immediately,
  // not wait for the next 5-min heartbeat.
  await updateStaleBadge();
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void enqueue('tabs.onActivated', async () => {
    const ts = Date.now();
    const prev = await getFocusedTabId();
    if (prev === tabId) return; // already accounted (e.g. via windows.onFocusChanged)
    if (prev !== undefined) await endFocusSegment(prev, ts);
    await setFocusedTabId(tabId);
    await startFocusSegment(tabId, ts, prev);
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  void enqueue('windows.onFocusChanged', async () => {
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
});

chrome.idle.onStateChanged.addListener((state) => {
  void enqueue('idle.onStateChanged', () => handleIdleChange(state));
});

async function handleIdleChange(state: chrome.idle.IdleState): Promise<void> {
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
}

// ── Tab move + attach/detach (cross-window moves) ──────────────────
// chrome.tabs.onMoved fires for in-window reorders; onAttached / onDetached
// fire for cross-window drags. None of these are inferable from onUpdated.
chrome.tabs.onMoved.addListener((tabId, info) => {
  void enqueue('tabs.onMoved', async () => {
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
});

chrome.tabs.onAttached.addListener((tabId, info) => {
  void enqueue('tabs.onAttached', async () => {
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
});

chrome.tabs.onDetached.addListener((tabId, info) => {
  void enqueue('tabs.onDetached', async () => {
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
});

// ── Tab-group lifecycle ─────────────────────────────────────────────
// Capture group create/update/remove so future models can reconstruct
// "user organized N tabs into a group named X at time T". Otherwise
// derivable only from periodic snapshots, which we don't take.
if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener((group) => {
    void enqueue('tabGroups.onCreated', async () => {
      await logEvent({
        type: 'group_created',
        windowId: group.windowId,
        groupId: group.id,
        groupTitle: group.title,
        meta: { color: group.color, collapsed: group.collapsed },
      });
    });
  });
  chrome.tabGroups.onUpdated.addListener((group) => {
    void enqueue('tabGroups.onUpdated', async () => {
      await logEvent({
        type: 'group_updated',
        windowId: group.windowId,
        groupId: group.id,
        groupTitle: group.title,
        meta: { color: group.color, collapsed: group.collapsed },
      });
    });
  });
  chrome.tabGroups.onRemoved.addListener((group) => {
    void enqueue('tabGroups.onRemoved', async () => {
      await logEvent({
        type: 'group_removed',
        windowId: group.windowId,
        groupId: group.id,
        groupTitle: group.title,
      });
    });
  });
}

// ── Window lifecycle ────────────────────────────────────────────────
// onCreated fires when the user spawns a new window; onRemoved when one
// closes (even if it had open tabs that get tracked individually).
chrome.windows.onCreated.addListener((window) => {
  void enqueue('windows.onCreated', async () => {
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
});

chrome.windows.onRemoved.addListener((windowId) => {
  void enqueue('windows.onRemoved', async () => {
    await logEvent({
      type: 'window_removed',
      windowId,
    });
  });
});

// We already react to onFocusChanged for state-management purposes (see
// above). Here we ALSO log it as an event — useful for reconstructing
// "which window was the user actually looking at" for cleanup-feature
// post-hoc analysis.
chrome.windows.onFocusChanged.addListener((windowId) => {
  void enqueue('windows.onFocusChanged', async () => {
    await logEvent({
      type: 'window_focus_changed',
      windowId: windowId === chrome.windows.WINDOW_ID_NONE ? undefined : windowId,
      meta: { lostFocus: windowId === chrome.windows.WINDOW_ID_NONE },
    });
  });
});
