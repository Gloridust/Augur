import { db, extractDomain } from '../shared/db';
import type {
  DomainStats,
  OpenCandidate,
  RecommendFeatures,
  RecommendationContext,
  TabEvent,
} from '../shared/types';
import { getDomainStats, getTopDomainsByFrecency } from './aggregate';
import { getEmbedding } from './embedding-train';
import { sessionContext as sessionContextFeature, visitVelocity } from './timeseries';
import {
  RECOMMEND_FEATURE_NAMES,
  buildRecommendFeatures,
  summarizeOpenReason,
  vectorFromRecommend,
} from './features';
import { BetaBandit } from './models/bandit';
import { OnlineLogReg } from './models/logreg';
import {
  loadBandit,
  loadRecommendForest,
  loadRecommendModel,
  loadSequenceMemory,
  saveBandit,
  saveRecommendModel,
} from './persistence';
import { DomainSequenceMemory } from './models/markov';
import { RandomForest } from './models/randomforest';
import { clamp } from './math';

const FEATURE_COUNT = RECOMMEND_FEATURE_NAMES.length;
const CANDIDATE_POOL = 80;
const MAX_SUGGESTIONS = 5;
const COLD_START_FRECENCY_FLOOR = 5;

let cachedModel: OnlineLogReg | null = null;
let cachedBandit: BetaBandit | null = null;
let cachedSeq: DomainSequenceMemory | null = null;
let cachedForest: RandomForest | null = null;

async function getModel(): Promise<OnlineLogReg> {
  if (!cachedModel) cachedModel = await loadRecommendModel(FEATURE_COUNT);
  return cachedModel;
}

async function getBandit(): Promise<BetaBandit> {
  if (!cachedBandit) cachedBandit = await loadBandit('recommend');
  return cachedBandit;
}

export async function getSequenceMemory(): Promise<DomainSequenceMemory> {
  if (!cachedSeq) cachedSeq = await loadSequenceMemory();
  return cachedSeq;
}

async function getForest(): Promise<RandomForest> {
  if (!cachedForest) cachedForest = await loadRecommendForest();
  return cachedForest;
}

// Invalidate the forest cache so the next inference reloads from KV. The
// nightly trainer calls this after persisting a freshly-fit forest so that
// the SW (which may have already loaded an older forest into memory) picks
// up the new one without restart.
export function invalidateForestCache(): void {
  cachedForest = null;
}

function banditArmId(domain: string): string {
  return domain;
}

async function topSitesPool(): Promise<DomainStats[]> {
  if (!chrome?.topSites?.get) return [];
  return new Promise((resolve) => {
    try {
      chrome.topSites.get((sites) => {
        const now = Date.now();
        const seen = new Set<string>();
        const out: DomainStats[] = [];
        for (const s of sites ?? []) {
          const domain = extractDomain(s.url);
          if (!domain || seen.has(domain)) continue;
          seen.add(domain);
          out.push({
            domain,
            visitCount: 1,
            visitsDecay: 0.5,
            totalFocusMs: 0,
            avgFocusMs: 0,
            closeWithoutFocusCount: 0,
            closeQuickCount: 0,
            hourDist: new Array(24).fill(0),
            dowDist: new Array(7).fill(0),
            lastVisit: now,
            updatedAt: now,
          });
        }
        resolve(out);
      });
    } catch {
      resolve([]);
    }
  });
}

async function lastEventForDomain(
  domain: string,
): Promise<{ url?: string; title?: string }> {
  const events = await db.events
    .where('[domain+ts]')
    .between([domain, 0], [domain, Date.now()], true, true)
    .reverse()
    .limit(40)
    .toArray();
  let url: string | undefined;
  let title: string | undefined;
  for (const e of events) {
    if ((e.type === 'open' || e.type === 'navigate') && e.url && !url) {
      url = e.url;
    }
    if (e.title && !title) {
      title = e.title;
    }
    if (url && title) break;
  }
  return { url, title };
}

function fallbackTitle(url: string, domain: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return domain;
  }
}

export interface RecommendCallContext extends RecommendationContext {
  pinnedDomains?: string[];
  // Recent focus sequence (oldest → newest, last entry = currently focused).
  // Used by the sequence-memory model for short/long/time predictions and
  // for candidate-pool augmentation. Caller (background SW) builds this from
  // chrome.storage.session.
  focusHistory?: string[];
}

export async function recommendOpen(
  context: RecommendCallContext,
): Promise<OpenCandidate[]> {
  const model = await getModel();
  const bandit = await getBandit();
  const embedding = await getEmbedding();
  const seq = await getSequenceMemory();
  const forest = await getForest();
  const forestReady = forest.isReady(FEATURE_COUNT);

  let pool = await getTopDomainsByFrecency(CANDIDATE_POOL);
  let isColdStart = false;
  if (pool.length < COLD_START_FRECENCY_FLOOR) {
    isColdStart = true;
    const seen = new Set(pool.map((p) => p.domain));
    const fallbacks = await topSitesPool();
    for (const f of fallbacks) {
      if (!seen.has(f.domain)) {
        pool.push(f);
        seen.add(f.domain);
      }
    }
  }

  // ── Candidate-pool augmentation via sequence memory ───────────────
  // The frecency pool is "what you visit a lot, ever". Sequence memory
  // adds "what you tend to open RIGHT NOW given recent focus + hour".
  // Without this step, the right next-domain often isn't even in the
  // candidate list — and no scoring fix can recover that.
  const focusHistory = context.focusHistory ?? [];
  const seqTop = seq.topPredictions(focusHistory, context.hour, Date.now(), 20);
  const poolDomains = new Set(pool.map((p) => p.domain));
  for (const { domain } of seqTop) {
    if (poolDomains.has(domain)) continue;
    if (!domain || domain.startsWith('chrome')) continue;
    const stat = (await getDomainStats(domain)) ?? {
      domain,
      visitCount: 0,
      visitsDecay: 0,
      totalFocusMs: 0,
      avgFocusMs: 0,
      closeWithoutFocusCount: 0,
      closeQuickCount: 0,
      hourDist: new Array(24).fill(0),
      dowDist: new Array(7).fill(0),
      lastVisit: 0,
      updatedAt: 0,
    };
    pool.push(stat);
    poolDomains.add(domain);
  }

  const openSet = new Set(context.openDomains);
  const pinnedSet = new Set(context.pinnedDomains ?? []);
  const now = Date.now();

  const candidates: OpenCandidate[] = [];
  for (let i = 0; i < pool.length; i++) {
    const stat = pool[i];
    if (!stat.domain || stat.domain.startsWith('chrome')) continue;
    const embedSim = context.focusedDomain
      ? embedding.cosine(stat.domain, context.focusedDomain)
      : 0;
    const [vel, sess] = await Promise.all([
      visitVelocity(stat.domain, now),
      sessionContextFeature(stat.domain, now),
    ]);
    // Three sequence-memory probabilities — short / long / time-of-day.
    // The LR head learns the optimal mix per user.
    const seqProbShort = seq.predictShort(focusHistory, stat.domain, now);
    const seqProbLong = seq.predictLong(focusHistory, stat.domain, embedding);
    const seqProbTime = seq.predictTime(focusHistory, stat.domain, context.hour);
    const features = await buildRecommendFeatures({
      domain: stat.domain,
      context,
      isCurrentlyOpen: openSet.has(stat.domain),
      isPinnedSomewhere: pinnedSet.has(stat.domain),
      embedSimToFocused: embedSim,
      visitVelocity: vel,
      sessionContext: sess,
      seqProbShort,
      seqProbLong,
      seqProbTime,
      now,
    });
    if (features.isCurrentlyOpen) continue;
    const xVec = vectorFromRecommend(features);
    const lrScore = model.predict(xVec);
    // Ensemble with the nightly-trained Random Forest if it's been trained
    // and matches the current feature shape. RF captures non-linear feature
    // interactions the linear LR can't. Equal weight for now — could be
    // learned per-user later via a calibration pass.
    const baseScore = forestReady
      ? 0.5 * lrScore + 0.5 * forest.predict(xVec)
      : lrScore;
    const banditMul = bandit.sample(banditArmId(stat.domain));
    let score = baseScore * (0.5 + banditMul);
    // During cold start the model and the bandit are both basically uniform,
    // so blend in topSites' own popularity order to give a sensible default.
    if (isColdStart) {
      const positionBoost = 1 - i / Math.max(pool.length, 1);
      score = score * 0.4 + positionBoost * 0.6;
    }
    const last = await lastEventForDomain(stat.domain);
    const url = last.url ?? `https://${stat.domain}`;
    const title = last.title ?? fallbackTitle(url, stat.domain);
    const reason = isColdStart && features.freqDecay <= 0.5
      ? 'popular'
      : summarizeOpenReason(features);
    candidates.push({
      domain: stat.domain,
      url,
      title,
      features,
      score: clamp(score, 0, 1),
      reason,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_SUGGESTIONS);
}

export async function recordRecommendImpressions(
  candidates: OpenCandidate[],
): Promise<void> {
  const bandit = await getBandit();
  for (const c of candidates) bandit.recordImpression(banditArmId(c.domain));
  await saveBandit('recommend', bandit);
}

export async function trainRecommendFeedback(
  domain: string,
  features: RecommendFeatures,
  action: 'accepted' | 'dismissed' | 'ignored',
): Promise<void> {
  const model = await getModel();
  const bandit = await getBandit();
  const label = action === 'accepted' ? 1 : 0;
  const weight = action === 'ignored' ? 0.3 : 1;
  model.update(vectorFromRecommend(features), label, weight);
  if (action === 'accepted') bandit.recordAccept(banditArmId(domain));
  else if (action === 'dismissed') bandit.recordDismiss(banditArmId(domain));
  else bandit.recordIgnore(banditArmId(domain), 0.3);

  await db.feedback.add({
    ts: Date.now(),
    surface: 'open',
    action,
    domain,
    features: features as unknown as Record<string, number>,
  });

  await saveRecommendModel(model);
  await saveBandit('recommend', bandit);
}

// Implicit positive: any time the user opens (or navigates to) a domain
// after the recommendation surface was rendered, treat it as a soft positive
// label for that domain in this context.
//
// Critical fix vs the previous implementation: this used to pass
// `focusedDomain: undefined, openDomains: []`, meaning every implicit
// positive was trained context-free — embedSim, isCurrentlyOpen, seqProb*
// all came out 0 at train time. The model was effectively learning the
// marginal feature distribution of ALL opens, not the conditional
// "given context X, opening Y is good."
//
// Now we pass the actual focus history, focused domain, and open domains
// from the SW. We also sample 5 negatives from the frecency pool — domains
// that were NOT opened in this context — at half weight. Without negatives,
// the LR can only learn "this is positive" and the score collapses to the
// prior. With them, the LR learns to discriminate.
export async function trainImplicitOpen(
  event: TabEvent,
  ctx?: {
    focusHistory?: string[];
    focusedDomain?: string;
    openDomains?: string[];
  },
): Promise<void> {
  if (!event.domain) return;
  if (event.type !== 'open' && event.type !== 'navigate') return;
  const model = await getModel();
  const embedding = await getEmbedding();
  const seq = await getSequenceMemory();

  const focusHistory = ctx?.focusHistory ?? [];
  const focusedDomain = ctx?.focusedDomain;
  const openDomains = ctx?.openDomains ?? [];
  const hour = event.hourOfDay ?? new Date(event.ts).getHours();
  const dow = event.dayOfWeek ?? new Date(event.ts).getDay();

  const buildFor = async (domain: string, isCurrentlyOpen: boolean) => {
    const embedSim = focusedDomain ? embedding.cosine(domain, focusedDomain) : 0;
    const [vel, sess] = await Promise.all([
      visitVelocity(domain, event.ts),
      sessionContextFeature(domain, event.ts),
    ]);
    const seqShort = seq.predictShort(focusHistory, domain, event.ts);
    const seqLong = seq.predictLong(focusHistory, domain, embedding);
    const seqTime = seq.predictTime(focusHistory, domain, hour);
    return buildRecommendFeatures({
      domain,
      context: {
        hour,
        dow,
        focusedDomain,
        openDomains,
      },
      isCurrentlyOpen,
      isPinnedSomewhere: false,
      embedSimToFocused: embedSim,
      visitVelocity: vel,
      sessionContext: sess,
      seqProbShort: seqShort,
      seqProbLong: seqLong,
      seqProbTime: seqTime,
      now: event.ts,
    });
  };

  // Positive sample for the domain the user actually opened.
  const posFeatures = await buildFor(event.domain, true);
  model.update(vectorFromRecommend(posFeatures), 1, 0.4);

  // Negative samples: pick 5 random domains from the frecency pool that
  // were NOT just opened. These teach the LR to discriminate "given THIS
  // context, the things you DIDN'T open are negatives."
  const NEG_COUNT = 5;
  const NEG_WEIGHT = 0.2;
  const pool = await getTopDomainsByFrecency(60);
  const eligible = pool.filter(
    (p) => p.domain && p.domain !== event.domain && !p.domain.startsWith('chrome'),
  );
  const shuffled = eligible.sort(() => Math.random() - 0.5).slice(0, NEG_COUNT);
  for (const stat of shuffled) {
    const negFeatures = await buildFor(stat.domain, openDomains.includes(stat.domain));
    model.update(vectorFromRecommend(negFeatures), 0, NEG_WEIGHT);
  }

  await saveRecommendModel(model);
}

export function clearSequenceMemoryCache(): void {
  cachedSeq = null;
}

export function clearRecommendCaches(): void {
  cachedModel = null;
  cachedBandit = null;
}
