import { extractDomain } from '../shared/db';
import type {
  CleanupFeatures,
  DomainStats,
  RecommendFeatures,
  RecommendationContext,
  TabRuntimeState,
} from '../shared/types';
import { softmax } from './math';
import { getCooccurrenceSum, getDomainStats } from './aggregate';

// IMPORTANT: append-only. Reordering breaks back-compat with persisted
// model weights — the loader keys features by index, not by name. New
// features go at the end; old ones stay even if deprecated (set to 0 in
// the builder). When adding/removing, also bump the model version key in
// persistence.ts so old weights are reset rather than silently mis-mapped.
export const CLEANUP_FEATURE_NAMES: Array<keyof CleanupFeatures> = [
  'tabAgeMs',
  'timeSinceFocusMs',
  'focusMs',
  'focusCount',
  'focusRate',
  'isPinned',
  'isGrouped',
  'domainVisitsDecay',
  'domainAvgFocusMs',
  'sameDomainOpenCount',
  'domainCloseQuickRate',
  'domainCloseWithoutFocusRate',
  'embedSimToOpen',
  'hour',
  'dow',
  // ── v3 additions ────────────────────────────────────────────────────
  'hourSin',
  'hourCos',
  'dowSin',
  'dowCos',
  'isDiscarded',
  'tabIndex',
  'isInActiveWindow',
  'windowSameDomainCount',
  'isInNamedGroup',
  'navCount',
  'isIdle',
  // ── v4: embedding-cluster task-state ────────────────────────────────
  'inActiveCluster',
  'clusterStaleness',
];

export const RECOMMEND_FEATURE_NAMES: Array<keyof RecommendFeatures> = [
  'freqDecay',
  'avgFocusMs',
  'hourMatch',
  'dowMatch',
  'recencyHours',
  'cooccurrenceWithFocused',
  'embedSimToFocused',
  'visitVelocity',
  'sessionContext',
  'isCurrentlyOpen',
  'isPinnedSomewhere',
  // ── v3 additions ────────────────────────────────────────────────────
  'hourSin',
  'hourCos',
  'dowSin',
  'dowCos',
  // ── v4 additions: three-timescale sequence memory ───────────────────
  'seqProbShort',
  'seqProbLong',
  'seqProbTime',
];

// Cyclic encoding: project an integer position on a circle of period N to
// (sin, cos) — gives the LR a continuous signal that's smooth across
// boundaries (23h → 0h is adjacent).
function cyclic(value: number, period: number): { sin: number; cos: number } {
  const theta = (2 * Math.PI * value) / period;
  return { sin: Math.sin(theta), cos: Math.cos(theta) };
}

export function vectorFromCleanup(f: CleanupFeatures): number[] {
  return CLEANUP_FEATURE_NAMES.map((n) => Number(f[n]) || 0);
}

export function vectorFromRecommend(f: RecommendFeatures): number[] {
  return RECOMMEND_FEATURE_NAMES.map((n) => Number(f[n]) || 0);
}

export function buildCleanupFeatures(args: {
  tab: chrome.tabs.Tab;
  state: TabRuntimeState | undefined;
  stats: DomainStats | undefined;
  sameDomainOpenCount: number;
  embedSimToOpen?: number;
  now: number;
  // ── v3 context ────────────────────────────────────────────────────
  // Total tab count in the same window (for normalizing tabIndex). Default
  // 1 keeps the field at 0 when context is missing.
  windowTabCount?: number;
  // tabs in same window AND same domain (duplicate scratch tabs).
  windowSameDomainCount?: number;
  // Currently focused window's id; tabs in this window get isInActiveWindow=1.
  activeWindowId?: number;
  // group title lookup. If the tab is in a group with non-empty title,
  // isInNamedGroup = 1.
  groupTitleById?: Record<number, string | undefined>;
  // System-level idle state (chrome.idle.IdleState).
  idleState?: 'active' | 'idle' | 'locked';
  // Embedding-cluster signals (computed once per cleanup pass and passed
  // through). 0 if clustering wasn't performed or this tab wasn't in any
  // cluster (e.g. unknown domain with no embedding).
  inActiveCluster?: boolean;
  clusterStaleness?: number;
}): CleanupFeatures {
  const {
    tab,
    state,
    stats,
    sameDomainOpenCount,
    embedSimToOpen,
    now,
    windowTabCount,
    windowSameDomainCount,
    activeWindowId,
    groupTitleById,
    idleState,
    inActiveCluster,
    clusterStaleness,
  } = args;
  const tabAgeMs = state ? Math.max(0, now - state.openedAt) : 0;
  const focusMs = state?.focusMs ?? 0;
  const focusCount = state?.focusCount ?? 0;
  const focusedAt = state?.focusedAt;
  const timeSinceFocusMs = focusedAt
    ? Math.max(0, now - focusedAt)
    : focusCount > 0
      ? Math.max(0, tabAgeMs - focusMs)
      : tabAgeMs;
  const focusRate = tabAgeMs > 0 ? focusMs / tabAgeMs : 0;
  const date = new Date(now);
  const hour = date.getHours();
  const dow = date.getDay();
  const hourCyc = cyclic(hour, 24);
  const dowCyc = cyclic(dow, 7);
  const visitCount = stats?.visitCount ?? 0;
  const closeQuickRate = visitCount > 0 ? (stats?.closeQuickCount ?? 0) / visitCount : 0;
  const closeWithoutFocusRate =
    visitCount > 0 ? (stats?.closeWithoutFocusCount ?? 0) / visitCount : 0;
  const groupId = tab.groupId ?? -1;
  const isGrouped = groupId >= 0 ? 1 : 0;
  const groupTitle = groupId >= 0 ? groupTitleById?.[groupId] : undefined;
  const isInNamedGroup = groupTitle && groupTitle.trim().length > 0 ? 1 : 0;
  const tabIdx = tab.index ?? 0;
  const tabIndexNorm =
    windowTabCount && windowTabCount > 1 ? tabIdx / (windowTabCount - 1) : 0;
  return {
    tabAgeMs,
    timeSinceFocusMs,
    focusMs,
    focusCount,
    focusRate,
    isPinned: tab.pinned ? 1 : 0,
    isGrouped,
    domainVisitsDecay: stats?.visitsDecay ?? 0,
    domainAvgFocusMs: stats?.avgFocusMs ?? 0,
    sameDomainOpenCount,
    domainCloseQuickRate: closeQuickRate,
    domainCloseWithoutFocusRate: closeWithoutFocusRate,
    embedSimToOpen: embedSimToOpen ?? 0,
    hour,
    dow,
    hourSin: hourCyc.sin,
    hourCos: hourCyc.cos,
    dowSin: dowCyc.sin,
    dowCos: dowCyc.cos,
    isDiscarded: tab.discarded ? 1 : 0,
    tabIndex: tabIndexNorm,
    isInActiveWindow:
      activeWindowId !== undefined && tab.windowId === activeWindowId ? 1 : 0,
    windowSameDomainCount: windowSameDomainCount ?? 0,
    isInNamedGroup,
    navCount: state?.navigationCount ?? 0,
    isIdle: idleState && idleState !== 'active' ? 1 : 0,
    inActiveCluster: inActiveCluster ? 1 : 0,
    clusterStaleness: clusterStaleness ?? 0,
  };
}

export async function buildRecommendFeatures(args: {
  domain: string;
  context: RecommendationContext;
  isCurrentlyOpen: boolean;
  isPinnedSomewhere: boolean;
  embedSimToFocused?: number;
  visitVelocity?: number;
  sessionContext?: number;
  // Sequence-memory probabilities for this candidate at three timescales.
  // All three default to 0 = "no signal" if the caller didn't compute them
  // (e.g. the implicit-train path on cold start).
  seqProbShort?: number;
  seqProbLong?: number;
  seqProbTime?: number;
  now: number;
}): Promise<RecommendFeatures> {
  const {
    domain,
    context,
    isCurrentlyOpen,
    isPinnedSomewhere,
    embedSimToFocused,
    visitVelocity,
    sessionContext,
    seqProbShort,
    seqProbLong,
    seqProbTime,
    now,
  } = args;
  const hourCyc = cyclic(context.hour, 24);
  const dowCyc = cyclic(context.dow, 7);
  const stats = await getDomainStats(domain);
  if (!stats) {
    return {
      freqDecay: 0,
      avgFocusMs: 0,
      hourMatch: 0,
      dowMatch: 0,
      recencyHours: 24 * 30,
      cooccurrenceWithFocused: 0,
      embedSimToFocused: embedSimToFocused ?? 0,
      visitVelocity: visitVelocity ?? 0,
      sessionContext: sessionContext ?? 0,
      isCurrentlyOpen: isCurrentlyOpen ? 1 : 0,
      isPinnedSomewhere: isPinnedSomewhere ? 1 : 0,
      hourSin: hourCyc.sin,
      hourCos: hourCyc.cos,
      dowSin: dowCyc.sin,
      dowCos: dowCyc.cos,
      seqProbShort: seqProbShort ?? 0,
      seqProbLong: seqProbLong ?? 0,
      seqProbTime: seqProbTime ?? 0,
    };
  }
  const hourSoft = softmax(stats.hourDist.map((v) => Math.log1p(v)));
  const dowSoft = softmax(stats.dowDist.map((v) => Math.log1p(v)));
  const recencyHours = Math.max(0, (now - stats.lastVisit) / (60 * 60 * 1000));
  const co = context.focusedDomain
    ? await getCooccurrenceSum(domain, [context.focusedDomain])
    : 0;
  return {
    freqDecay: stats.visitsDecay,
    avgFocusMs: stats.avgFocusMs,
    hourMatch: hourSoft[context.hour] ?? 0,
    dowMatch: dowSoft[context.dow] ?? 0,
    recencyHours,
    cooccurrenceWithFocused: co,
    embedSimToFocused: embedSimToFocused ?? 0,
    visitVelocity: visitVelocity ?? 0,
    sessionContext: sessionContext ?? 0,
    isCurrentlyOpen: isCurrentlyOpen ? 1 : 0,
    isPinnedSomewhere: isPinnedSomewhere ? 1 : 0,
    hourSin: hourCyc.sin,
    hourCos: hourCyc.cos,
    dowSin: dowCyc.sin,
    dowCos: dowCyc.cos,
    seqProbShort: seqProbShort ?? 0,
    seqProbLong: seqProbLong ?? 0,
    seqProbTime: seqProbTime ?? 0,
  };
}

export function summarizeCleanupReason(f: CleanupFeatures): string {
  const hours = Math.round(f.timeSinceFocusMs / (60 * 60 * 1000));
  if (f.focusCount === 0) return 'never-focused';
  if (f.focusRate < 0.01 && f.tabAgeMs > 60 * 60 * 1000) return 'low-engagement';
  if (hours >= 24) return 'idle-day-plus';
  if (hours >= 4) return 'idle-hours';
  if (f.sameDomainOpenCount > 3) return 'duplicate-domain';
  return 'stale';
}

export function summarizeOpenReason(f: RecommendFeatures): string {
  if (f.cooccurrenceWithFocused > 1.5) return 'co-opens-with-current';
  if (f.embedSimToFocused > 0.4) return 'semantically-related';
  if (f.hourMatch > 0.15) return 'matches-time-of-day';
  if (f.recencyHours < 4) return 'recent';
  if (f.freqDecay > 5) return 'frequent';
  return 'historical';
}

export function domainFromUrl(url: string | undefined): string {
  return extractDomain(url);
}
