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
  action: 'accepted' | 'dismissed' | 'snoozed' | 'ignored';
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
