import { db, extractDomain } from '../shared/db';
import type { CleanupCandidate, CleanupFeatures } from '../shared/types';
import { getIdleState, getStateMap } from '../background/state';
import { getDomainStats } from './aggregate';
import { clusterByEmbedding, type ClusterMember } from './cluster';
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
  const idleState = await getIdleState();

  // Pre-compute same-domain counts and the set of "engaged" open domains —
  // these are what cleanup similarity is measured against.
  const domainCount = new Map<string, number>();
  const engagedOpenDomains = new Set<string>();
  for (const t of tabs) {
    const d = extractDomain(t.url);
    domainCount.set(d, (domainCount.get(d) ?? 0) + 1);
    if (d && (t.pinned || t.active)) engagedOpenDomains.add(d);
  }

  // Per-window stats — count tabs and same-domain tabs per window. Cheap;
  // single pass keeps it O(n).
  const windowTabCount = new Map<number, number>();
  const windowDomainCount = new Map<string, number>(); // key: `${windowId}|${domain}`
  for (const t of tabs) {
    if (t.windowId === undefined) continue;
    windowTabCount.set(t.windowId, (windowTabCount.get(t.windowId) ?? 0) + 1);
    const d = extractDomain(t.url);
    if (!d) continue;
    const k = `${t.windowId}|${d}`;
    windowDomainCount.set(k, (windowDomainCount.get(k) ?? 0) + 1);
  }

  // Pre-fetch the focused window id and tab-group titles. These are the
  // only async chrome.* calls we need for the new features and they're
  // cheap (one round-trip each, regardless of tab count).
  let activeWindowId: number | undefined;
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    activeWindowId = win?.id;
  } catch {
    // chrome.windows can throw in restricted contexts — leave undefined.
  }
  const groupTitleById: Record<number, string | undefined> = {};
  try {
    if (chrome.tabGroups?.query) {
      const groups = await chrome.tabGroups.query({});
      for (const g of groups) groupTitleById[g.id] = g.title;
    }
  } catch {
    // chrome.tabGroups requires the tabGroups permission (we have it) but
    // can still fail in some flows — degrade gracefully.
  }

  // Hardcoded dashboard URL pattern — we can compute it via chrome.runtime
  // here too, but a string check works in the SW context without touching
  // chrome.runtime.getURL (which can be undefined in some test paths).
  // MUST be declared before the cluster code below references it — `const`
  // bindings are in their TDZ until the line they're declared on, so any
  // earlier reference (like the embedding-cluster filter that uses it)
  // throws "Cannot access 'dashboardUrlMatch' before initialization".
  const dashboardUrlMatch = (url: string | undefined): boolean => {
    if (!url) return false;
    if (url === 'chrome://newtab/' || url === 'chrome://new-tab-page/') return true;
    if (chrome?.runtime?.getURL) {
      const dash = chrome.runtime.getURL('src/dashboard/index.html');
      if (url === dash || url.startsWith(dash)) return true;
    }
    return false;
  };

  // ── Embedding-cluster task-state ───────────────────────────────────
  // Cluster open tabs by skip-gram cosine similarity. The "active cluster"
  // is the one whose members have the most recent aggregate focus — tabs
  // in that cluster share task semantics with what the user's currently
  // engaged with, so the cleanup head should leave them alone. Tabs in
  // STALE clusters (no recent focus across the whole cluster) are stronger
  // cleanup candidates than their per-tab stats alone would suggest.
  const clusterableTabs = tabs.filter(
    (t) =>
      t.id !== undefined &&
      !t.pinned &&
      !t.audible &&
      !dashboardUrlMatch(t.url) &&
      extractDomain(t.url) &&
      embedding.has(extractDomain(t.url)),
  );
  const clusterMembers: ClusterMember<{ tabId: number; lastFocusMs: number }>[] =
    clusterableTabs.map((t) => {
      const st = stateMap[t.id!];
      // "Last focus" = focusedAt if currently focused, else
      // openedAt + focusMs (rough proxy for "recently engaged").
      const lastFocusMs = st?.focusedAt ?? (st ? st.openedAt + st.focusMs : 0);
      return {
        domain: extractDomain(t.url),
        payload: { tabId: t.id!, lastFocusMs },
      };
    });
  const clusters = clusterByEmbedding(clusterMembers, embedding, 0.35);

  // Pick the active cluster: highest max(lastFocusMs) across its members.
  let activeClusterIdx = -1;
  let activeClusterFocus = -1;
  for (let i = 0; i < clusters.length; i++) {
    let maxFocus = 0;
    for (const m of clusters[i].members) {
      if (m.payload.lastFocusMs > maxFocus) maxFocus = m.payload.lastFocusMs;
    }
    if (maxFocus > activeClusterFocus) {
      activeClusterFocus = maxFocus;
      activeClusterIdx = i;
    }
  }
  // Compute per-cluster staleness = (now - maxFocusInCluster) / 24h, clamped 0..1
  const STALENESS_HORIZON = 24 * 60 * 60 * 1000;
  const clusterStaleness: number[] = clusters.map((c) => {
    let maxF = 0;
    for (const m of c.members) {
      if (m.payload.lastFocusMs > maxF) maxF = m.payload.lastFocusMs;
    }
    if (maxF === 0) return 1;
    const dt = now - maxF;
    return Math.max(0, Math.min(1, dt / STALENESS_HORIZON));
  });
  // Reverse index: tabId → cluster idx
  const tabToCluster = new Map<number, number>();
  for (let i = 0; i < clusters.length; i++) {
    for (const m of clusters[i].members) {
      tabToCluster.set(m.payload.tabId, i);
    }
  }

  const candidates: CleanupCandidate[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    if (tab.pinned) continue; // Never suggest closing pinned tabs.
    if (tab.active) continue; // Don't suggest closing the focused tab.
    if (tab.audible) continue; // Hard rule: never auto-flag a media-playing tab.
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
    const winId = tab.windowId;
    const myClusterIdx = tabToCluster.get(tab.id) ?? -1;
    const inActive = myClusterIdx >= 0 && myClusterIdx === activeClusterIdx;
    const staleness =
      myClusterIdx >= 0 ? clusterStaleness[myClusterIdx] : 0;
    const features = buildCleanupFeatures({
      tab,
      state,
      stats,
      sameDomainOpenCount: domainCount.get(domain) ?? 1,
      embedSimToOpen: embedSim,
      now,
      windowTabCount: winId !== undefined ? windowTabCount.get(winId) : undefined,
      windowSameDomainCount:
        winId !== undefined ? windowDomainCount.get(`${winId}|${domain}`) : undefined,
      activeWindowId,
      groupTitleById,
      idleState,
      inActiveCluster: inActive,
      clusterStaleness: staleness,
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
  action: 'accepted' | 'dismissed' | 'snoozed' | 'dismissed-after-suggestion',
): Promise<void> {
  const model = await getModel();
  const bandit = await getBandit();
  const armId = banditArmId(domain, reason);

  // Label: accepted = positive (yes, this should have been closed); all
  // other actions are negatives. Weight conveys signal strength:
  //   - snoozed: 0.5 (soft "ask later")
  //   - dismissed-after-suggestion: 2.0 (high-value correction — model
  //     was confident enough to flag this in the smart-cleanup batch and
  //     the user explicitly toggled it off)
  //   - accepted / dismissed: 1.0
  const label = action === 'accepted' ? 1 : 0;
  const weight =
    action === 'snoozed'
      ? 0.5
      : action === 'dismissed-after-suggestion'
        ? 2.0
        : 1.0;
  model.update(vectorFromCleanup(features), label, weight);

  if (action === 'accepted') bandit.recordAccept(armId);
  else if (action === 'dismissed' || action === 'dismissed-after-suggestion') {
    bandit.recordDismiss(armId);
  } else bandit.recordIgnore(armId, 0.5);

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
