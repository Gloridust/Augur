// Event types are an APPEND-ONLY string union. Old events with retired
// type strings stay in the events table; new code reading the table just
// ignores types it doesn't recognize. The `type` Dexie index works on
// string equality and doesn't care about the union shape.
//
// Categories:
//   1. Core lifecycle (the original set) — open/close/focus/blur/navigate/...
//   2. Tab-state transitions — pin/audible/discard/move/group changes
//   3. Window lifecycle — create/remove + focus transitions
//   4. Product-surface events — actions the user takes on Augur's own UI
//      (pin add, stash, workspace save, OracleHint accept, smart cleanup,
//      search). These are NOT inferable from chrome.* events alone, so we
//      log them explicitly for future-model training data.
export type EventType =
  // ── 1. Core lifecycle ───────────────────────────────────────────
  | 'open'
  | 'close'
  | 'focus'
  | 'blur'
  | 'navigate'
  | 'reopen'
  | 'idle_active'
  | 'idle_idle'
  | 'idle_locked'
  // ── 2. Tab-state transitions ────────────────────────────────────
  | 'tab_pinned'
  | 'tab_unpinned'
  | 'tab_audible_start'
  | 'tab_audible_end'
  | 'tab_muted'
  | 'tab_unmuted'
  | 'tab_discarded'
  | 'tab_undiscarded'
  | 'tab_moved'
  | 'tab_attached'   // moved to a different window
  | 'tab_detached'
  // ── 3. Tab-group lifecycle ──────────────────────────────────────
  | 'group_created'
  | 'group_updated'
  | 'group_removed'
  | 'tab_grouped'
  | 'tab_ungrouped'
  // ── 4. Window lifecycle ─────────────────────────────────────────
  | 'window_created'
  | 'window_removed'
  | 'window_focus_changed'
  // ── 5. Product-surface events ───────────────────────────────────
  | 'pin_added'
  | 'pin_removed'
  | 'pin_reordered'
  | 'stash_added'
  | 'stash_unstashed'
  | 'stash_deleted'
  | 'workspace_saved'
  | 'workspace_restored'
  | 'workspace_updated'
  | 'workspace_deleted'
  | 'oracle_shown'
  | 'oracle_accepted'
  | 'oracle_dismissed'
  | 'oracle_slot_changed'
  | 'cleanup_card_shown'
  | 'smart_cleanup_shown'
  | 'smart_cleanup_committed'
  | 'search_executed'
  | 'tab_filter_typed';

export type OpenSource =
  | 'search'
  | 'link'
  | 'direct'
  | 'restore'
  | 'recommendation'
  | 'unknown';

export interface TabEvent {
  id?: number;
  ts: number;
  type: EventType;
  tabId?: number;
  windowId?: number;
  url?: string;
  domain?: string;
  title?: string;
  hourOfDay?: number;
  dayOfWeek?: number;
  durationMs?: number;
  focusMs?: number;
  focusCount?: number;
  prevTabId?: number;
  openedFrom?: OpenSource;
  // Snapshot fields — capture chrome.tabs.Tab state at event time so future
  // models can reconstruct the situation without replaying the whole event
  // log. All optional for back-compat; older events simply lack them.
  tabIndex?: number;
  audible?: boolean;
  muted?: boolean;
  discarded?: boolean;
  pinned?: boolean;
  groupId?: number;
  groupTitle?: string;
  openerTabId?: number;
  // Surface-specific payloads (search query, oracle slot, smart-cleanup
  // batch composition, etc). The free-form `meta` is the catchall for
  // anything that doesn't deserve a top-level field.
  query?: string;
  slotIndex?: number;
  count?: number;
  domains?: string[];
  meta?: Record<string, unknown>;
}

export interface TabRuntimeState {
  tabId: number;
  url: string;
  domain: string;
  title?: string;
  openedAt: number;
  focusedAt?: number;
  focusMs: number;
  focusCount: number;
  pinned: boolean;
  groupId: number;
  // Number of in-tab URL changes since the tab was created (incremented on
  // each `chrome.tabs.onUpdated` navigation). Multi-page sessions ≠ static
  // one-shot tabs — useful cleanup signal.
  navigationCount?: number;
}

export interface DataSummary {
  eventCount: number;
  domainCount: number;
  feedbackCount: number;
  cleanupTrainedSamples: number;
  cleanupPositiveSamples: number;
  recommendTrainedSamples: number;
  recommendPositiveSamples: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
  // Heuristic threshold for "model is warm enough to give meaningful results".
  recommendationsReady: boolean;
  cleanupReady: boolean;
}

export interface DomainGroup {
  domain: string;
  tabs: chrome.tabs.Tab[];
}

// ─── ML / aggregates ─────────────────────────────────────────────────────────

export interface DomainStats {
  domain: string;
  visitCount: number;
  visitsDecay: number;
  totalFocusMs: number;
  avgFocusMs: number;
  closeWithoutFocusCount: number;
  closeQuickCount: number;
  hourDist: number[];
  dowDist: number[];
  lastVisit: number;
  updatedAt: number;
}

export interface CoOccurrence {
  pair: string;
  a: string;
  b: string;
  count: number;
  lastSeen: number;
}

export interface CleanupFeatures {
  tabAgeMs: number;
  timeSinceFocusMs: number;
  focusMs: number;
  focusCount: number;
  focusRate: number;
  isPinned: number;
  isGrouped: number;
  domainVisitsDecay: number;
  domainAvgFocusMs: number;
  sameDomainOpenCount: number;
  domainCloseQuickRate: number;
  domainCloseWithoutFocusRate: number;
  embedSimToOpen: number;
  hour: number;
  dow: number;
  // ── Cyclic time encoding — sin/cos of hour and day-of-week. Continuous
  //    space lets the model generalize across nearby hours (8am ≈ 9am)
  //    instead of learning each bin independently.
  hourSin: number;
  hourCos: number;
  dowSin: number;
  dowCos: number;
  // ── Tab-level state Chrome reports directly. `audible` triggers a hard
  //    exclusion in scoreCleanupCandidates; `discarded` is a soft signal
  //    (Chrome already unloaded it = user hasn't touched it).
  isDiscarded: number;
  // ── Position in the window's tab strip, normalized to 0..1. Rightmost
  //    tabs are usually newer / more transient.
  tabIndex: number;
  // ── Whether this tab lives in the currently focused window — focused
  //    window tabs tend to be active workflow.
  isInActiveWindow: number;
  // ── Count of tabs in the same window with the same domain. High counts
  //    signal duplicates / scratch tabs.
  windowSameDomainCount: number;
  // ── Tab is in a tab group AND that group has a non-empty title.
  //    Named groups are intentional buckets — strong "keep" signal.
  isInNamedGroup: number;
  // ── How many in-tab navigations have happened (URL changes since open).
  //    Workflow tabs accumulate navigations; one-shot tabs don't.
  navCount: number;
  // ── User idle right now (system idle / locked). Tabs sitting open while
  //    the user is away are weaker signals than tabs ignored while active.
  isIdle: number;
  // ── Embedding-cluster task-state features. Open tabs are clustered by
  //    skip-gram cosine similarity; clusters are scored by their members'
  //    recent focus. The "active cluster" is the one with the most recent
  //    aggregate focus. `inActiveCluster` marks tabs that share task
  //    semantics with what the user's currently engaged with (don't close).
  //    `clusterStaleness` ∈ [0, 1] measures how stale the tab's cluster
  //    is — high = a clearly-abandoned task group.
  inActiveCluster: number;
  clusterStaleness: number;
}

export interface RecommendFeatures {
  freqDecay: number;
  avgFocusMs: number;
  hourMatch: number;
  dowMatch: number;
  recencyHours: number;
  cooccurrenceWithFocused: number;
  embedSimToFocused: number;
  // Time-series enrichment — visit velocity (last-24h rate vs 14-day baseline)
  // and session context (visited within the current "session", i.e., last 30
  // minutes). These let the model spot rising/falling and momentary domains.
  visitVelocity: number;
  sessionContext: number;
  isCurrentlyOpen: number;
  isPinnedSomewhere: number;
  // Cyclic time encoding (matches CleanupFeatures) — global "what time
  // does this user usually want X" signal, complementing the per-domain
  // hourMatch/dowMatch softmaxes above.
  hourSin: number;
  hourCos: number;
  dowSin: number;
  dowCos: number;
  // Sequence-memory probabilities at three timescales — see
  // src/ml/models/markov.ts. The LR head learns the per-user mixture.
  seqProbShort: number;  // exp-decayed transitions in last ~30min
  seqProbLong: number;   // bigram + trigram counts, embedding-smoothed
  seqProbTime: number;   // bigram conditioned on hour-of-day bucket
  // ── v8 additions ────────────────────────────────────────────────────
  // Directed transition affinity sigmoid(inVec[focused]·outVec[candidate]):
  // asymmetric A→B likelihood from the skip-gram's separate in/out tables.
  transitionAffinity: number;
  // Multi-tab session context (intent is often spread across several open
  // tabs, not just the focused one). sessionSim = cosine(candidate,
  // session-vector); sessionCohesion = how tight the session cluster is
  // (high = deep in one workflow, trust sessionSim; low = wandering).
  sessionSim: number;
  sessionCohesion: number;
  // Where in the browsing session we are. First-tab intent (mail / news
  // ritual) differs systematically from mid-session continuation.
  minutesIntoSession: number;
  isSessionStart: number;
  // z-score of the current hour against the user's OWN activity rhythm.
  hourActivityZ: number;
  // Per-domain acceptance posterior as a logit feature (Phase 4.1) —
  // replaces the old hard-coded multiplicative bandit blend.
  banditLogit: number;
  // Share of the domain's traffic concentrated in its single top URL
  // prefix — high means a domain-level pick maps to a precise page.
  prefixConcentration: number;
  // ── Semantic layer (textembed/domaintext) ──────────────────────────
  // Text-vector similarity of the candidate's pages to the focused domain's
  // and to the session's — captures shared vocabulary/topic even between
  // domains never co-visited (which the co-occurrence skip-gram can't).
  titleSimToFocused: number;
  titleSimToSession: number;
  // ── Factorized transition model (models/transition.ts) ──────────────
  // Generalizing next-domain score from learned u(context)·v(target)
  // vectors — fires even for (from→to) pairs the count tables never saw.
  factorizedTransition: number;
}

export interface RecommendationContext {
  hour: number;
  dow: number;
  focusedDomain?: string;
  openDomains: string[];
}

// Confidence/recency tier for a cleanup candidate, ordered most→least
// obviously a zombie. The bulk "declutter" sweep surfaces ALL of these and
// lets the user deselect; the precise inline card only uses model-flagged
// picks. `model` = flagged by the LR head but not caught by a staleness rule.
export type CleanupTier =
  | 'never_opened' // focused 0 times since open (opened, never looked at)
  | 'stale_week' // not focused in ≥ 7 days
  | 'stale_day' // not focused in ≥ 24 h
  | 'stale' // not focused in ≥ a few hours
  | 'model'; // model-confident, no staleness rule matched

export interface CleanupCandidate {
  tab: chrome.tabs.Tab;
  features: CleanupFeatures;
  score: number;
  reason: string;
  // Present on bulk-sweep results; absent on the precise inline path.
  tier?: CleanupTier;
}

// Result of the bulk declutter sweep — the full stale population plus the
// totals needed to show "N of M tabs are stale".
export interface CleanupSweep {
  candidates: CleanupCandidate[];
  totalTabs: number; // all open tabs (incl. pinned/active)
  staleTabs: number; // candidates.length, for convenience
}

export interface OpenCandidate {
  domain: string;
  url: string;
  title: string;
  features: RecommendFeatures;
  score: number;
  reason: string;
}

export interface FeedbackEvent {
  ts: number;
  surface: 'cleanup' | 'open';
  // 'dismissed-after-suggestion' = the model auto-flagged this tab in the
  // smart-cleanup batch and the user explicitly unchecked it. Trained with
  // 2× the weight of a regular dismiss because it directly contradicts a
  // confident model prediction.
  action:
    | 'accepted'
    | 'dismissed'
    | 'snoozed'
    | 'ignored'
    | 'dismissed-after-suggestion';
  domain?: string;
  url?: string;
  features?: Record<string, number>;
}

export interface StashedTab {
  id?: number;
  url: string;
  title: string;
  domain: string;
  favIconUrl?: string;
  stashedAt: number;
  source: 'manual' | 'cleanup';
  note?: string;
}

export interface WorkspaceTab {
  url: string;
  title: string;
  favIconUrl?: string;
  pinned: boolean;
}

export interface Workspace {
  id?: number;
  name: string;
  tabs: WorkspaceTab[];
  domains: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TodayRecap {
  tabsOpened: number;
  domainsVisited: number;
  focusMinutes: number;
  topDomain?: { domain: string; focusMs: number };
  busiestHour?: { hour: number; eventCount: number };
}

export interface WindowGroup {
  windowId: number;
  windowIndex: number;
  tabs: chrome.tabs.Tab[];
  activeTabTitle?: string;
}

export interface PinnedItem {
  id?: number;
  // Stable key for dedupe; URL is what matters for "is this pinned".
  key: string;
  url: string;
  title: string;
  domain: string;
  favIconUrl?: string;
  pinnedAt: number;
  // 0..N — smaller is leftmost. Reseeded on every drag-reorder.
  manualOrder: number;
}
