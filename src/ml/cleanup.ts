import { db, extractDomain } from '../shared/db';
import type { CleanupCandidate, CleanupFeatures } from '../shared/types';
import { getStateMap } from '../background/state';
import { getDomainStats } from './aggregate';
import { getEmbedding } from './embedding-train';
import {
  buildCleanupFeatures,
  summarizeCleanupReason,
  vectorFromCleanup,
} from './features';
import { BetaBandit } from './models/bandit';
import { OnlineLogReg } from './models/logreg';
import { clamp } from './math';
import {
  loadBandit,
  loadCleanupModel,
  saveBandit,
  saveCleanupModel,
} from './persistence';
import { CLEANUP_FEATURE_NAMES } from './features';

const FEATURE_COUNT = CLEANUP_FEATURE_NAMES.length;
const MIN_TAB_AGE_FOR_SUGGEST_MS = 30 * 60 * 1000;
const MAX_SUGGESTIONS = 5;
const SCORE_THRESHOLD = 0.55;

let cachedModel: OnlineLogReg | null = null;
let cachedBandit: BetaBandit | null = null;

async function getModel(): Promise<OnlineLogReg> {
  if (!cachedModel) cachedModel = await loadCleanupModel(FEATURE_COUNT);
  return cachedModel;
}

async function getBandit(): Promise<BetaBandit> {
  if (!cachedBandit) cachedBandit = await loadBandit('cleanup');
  return cachedBandit;
}

function banditArmId(domain: string, reason: string): string {
  return `${domain}|${reason}`;
}

export async function scoreCleanupCandidates(
  tabs: chrome.tabs.Tab[],
  now: number = Date.now(),
  limit: number = MAX_SUGGESTIONS,
): Promise<CleanupCandidate[]> {
  if (tabs.length === 0) return [];
  const model = await getModel();
  const bandit = await getBandit();
  const stateMap = await getStateMap();
  const embedding = await getEmbedding();

  // Pre-compute same-domain counts and the set of "engaged" open domains —
  // these are what cleanup similarity is measured against.
  const domainCount = new Map<string, number>();
  const engagedOpenDomains = new Set<string>();
  for (const t of tabs) {
    const d = extractDomain(t.url);
    domainCount.set(d, (domainCount.get(d) ?? 0) + 1);
    if (d && (t.pinned || t.active)) engagedOpenDomains.add(d);
  }

  // Hardcoded dashboard URL pattern — we can compute it via chrome.runtime
  // here too, but a string check works in the SW context without touching
  // chrome.runtime.getURL (which can be undefined in some test paths).
  const dashboardUrlMatch = (url: string | undefined): boolean => {
    if (!url) return false;
    if (url === 'chrome://newtab/' || url === 'chrome://new-tab-page/') return true;
    if (chrome?.runtime?.getURL) {
      const dash = chrome.runtime.getURL('src/dashboard/index.html');
      if (url === dash || url.startsWith(dash)) return true;
    }
    return false;
  };

  const candidates: CleanupCandidate[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    if (tab.pinned) continue; // Never suggest closing pinned tabs.
    if (tab.active) continue; // Don't suggest closing the focused tab.
    if (dashboardUrlMatch(tab.url)) continue; // Never suggest closing the dashboard itself.
    const domain = extractDomain(tab.url);
    if (!domain) continue;
    const state = stateMap[tab.id];
    if (state) {
      const ageMs = now - state.openedAt;
      if (ageMs < MIN_TAB_AGE_FOR_SUGGEST_MS) continue;
    }
    const stats = await getDomainStats(domain);
    const otherOpens = Array.from(engagedOpenDomains).filter((d) => d !== domain);
    const embedSim = embedding.meanCosine(domain, otherOpens);
    const features = buildCleanupFeatures({
      tab,
      state,
      stats,
      sameDomainOpenCount: domainCount.get(domain) ?? 1,
      embedSimToOpen: embedSim,
      now,
    });
    const baseScore = model.predict(vectorFromCleanup(features));
    const reason = summarizeCleanupReason(features);
    const banditMul = bandit.sample(banditArmId(domain, reason));
    const score = baseScore * (0.5 + banditMul);
    candidates.push({ tab, features, score: clamp(score, 0, 1), reason });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.filter((c) => c.score >= SCORE_THRESHOLD).slice(0, limit);
}

export async function recordCleanupImpressions(
  candidates: CleanupCandidate[],
): Promise<void> {
  const bandit = await getBandit();
  for (const c of candidates) {
    const domain = extractDomain(c.tab.url);
    bandit.recordImpression(banditArmId(domain, c.reason));
  }
  await saveBandit('cleanup', bandit);
}

export async function trainCleanupFeedback(
  features: CleanupFeatures,
  domain: string,
  reason: string,
  action: 'accepted' | 'dismissed' | 'snoozed',
): Promise<void> {
  const model = await getModel();
  const bandit = await getBandit();
  const armId = banditArmId(domain, reason);

  // Label: accepted = positive (yes, this should have been closed),
  // dismissed = explicit negative, snoozed = soft negative.
  const label = action === 'accepted' ? 1 : 0;
  const weight = action === 'snoozed' ? 0.5 : 1.0;
  model.update(vectorFromCleanup(features), label, weight);

  if (action === 'accepted') bandit.recordAccept(armId);
  else if (action === 'dismissed') bandit.recordDismiss(armId);
  else bandit.recordIgnore(armId, 0.5);

  await db.feedback.add({
    ts: Date.now(),
    surface: 'cleanup',
    action,
    domain,
    features: features as unknown as Record<string, number>,
  });

  await saveCleanupModel(model);
  await saveBandit('cleanup', bandit);
}

// Implicit labels: a tab the user proactively closed without us suggesting it
// is a positive example (especially if low engagement). A tab still open after
// 7 days with non-trivial focus is a negative example.
export async function trainImplicitCleanup(args: {
  features: CleanupFeatures;
  domain: string;
  closedByUser: boolean;
}): Promise<void> {
  const model = await getModel();
  if (args.closedByUser) {
    const isStale =
      args.features.focusRate < 0.05 ||
      args.features.timeSinceFocusMs > 6 * 60 * 60 * 1000;
    model.update(vectorFromCleanup(args.features), isStale ? 1 : 0, 0.4);
  } else {
    const isKept =
      args.features.tabAgeMs > 7 * 24 * 60 * 60 * 1000 && args.features.focusCount > 1;
    if (isKept) model.update(vectorFromCleanup(args.features), 0, 0.4);
  }
  await saveCleanupModel(model);
}

export function clearCleanupCaches(): void {
  cachedModel = null;
  cachedBandit = null;
}
