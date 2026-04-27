export type EventType =
  | 'open'
  | 'close'
  | 'focus'
  | 'blur'
  | 'navigate'
  | 'reopen'
  | 'idle_active'
  | 'idle_idle'
  | 'idle_locked';

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
}

export interface RecommendationContext {
  hour: number;
  dow: number;
  focusedDomain?: string;
  openDomains: string[];
}

export interface CleanupCandidate {
  tab: chrome.tabs.Tab;
  features: CleanupFeatures;
  score: number;
  reason: string;
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
