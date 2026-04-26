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
];

export const RECOMMEND_FEATURE_NAMES: Array<keyof RecommendFeatures> = [
  'freqDecay',
  'avgFocusMs',
  'hourMatch',
  'dowMatch',
  'recencyHours',
  'cooccurrenceWithFocused',
  'embedSimToFocused',
  'isCurrentlyOpen',
  'isPinnedSomewhere',
];

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
}): CleanupFeatures {
  const { tab, state, stats, sameDomainOpenCount, embedSimToOpen, now } = args;
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
  const visitCount = stats?.visitCount ?? 0;
  const closeQuickRate = visitCount > 0 ? (stats?.closeQuickCount ?? 0) / visitCount : 0;
  const closeWithoutFocusRate =
    visitCount > 0 ? (stats?.closeWithoutFocusCount ?? 0) / visitCount : 0;
  return {
    tabAgeMs,
    timeSinceFocusMs,
    focusMs,
    focusCount,
    focusRate,
    isPinned: tab.pinned ? 1 : 0,
    isGrouped: tab.groupId !== undefined && tab.groupId >= 0 ? 1 : 0,
    domainVisitsDecay: stats?.visitsDecay ?? 0,
    domainAvgFocusMs: stats?.avgFocusMs ?? 0,
    sameDomainOpenCount,
    domainCloseQuickRate: closeQuickRate,
    domainCloseWithoutFocusRate: closeWithoutFocusRate,
    embedSimToOpen: embedSimToOpen ?? 0,
    hour: date.getHours(),
    dow: date.getDay(),
  };
}

export async function buildRecommendFeatures(args: {
  domain: string;
  context: RecommendationContext;
  isCurrentlyOpen: boolean;
  isPinnedSomewhere: boolean;
  embedSimToFocused?: number;
  now: number;
}): Promise<RecommendFeatures> {
  const { domain, context, isCurrentlyOpen, isPinnedSomewhere, embedSimToFocused, now } = args;
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
      isCurrentlyOpen: isCurrentlyOpen ? 1 : 0,
      isPinnedSomewhere: isPinnedSomewhere ? 1 : 0,
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
    isCurrentlyOpen: isCurrentlyOpen ? 1 : 0,
    isPinnedSomewhere: isPinnedSomewhere ? 1 : 0,
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
