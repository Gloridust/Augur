import { db, extractDomain } from '../shared/db';
import { logError } from '../shared/errorlog';
import { dinAttention } from './attention';
import type {
  DomainStats,
  OpenCandidate,
  RecommendFeatures,
  RecommendationContext,
  TabEvent,
} from '../shared/types';
import { getDomainStats, getTopDomainsByFrecency } from './aggregate';
import { getEmbedding } from './embedding-train';
import {
  buildTimeseriesSnapshot,
  sessionContext as sessionContextFeature,
  visitVelocity,
} from './timeseries';
import {
  RECOMMEND_FEATURE_NAMES,
  buildRecommendFeatures,
  buildSessionVector,
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
  saveSequenceMemory,
} from './persistence';
import { markDirty } from './flush';
import { lazy } from './lazy';
import { DomainSequenceMemory } from './models/markov';
import { RandomForest } from './models/randomforest';
import { SkipGramEmbedding } from './models/embedding';
import { TransitionModel } from './models/transition';
import { TinyMLP } from './models/mlp';
import {
  hourActivityZFrom,
  loadCircadian,
  type CircadianState,
} from './circadian';
import {
  loadUrlPrefixes,
  topPrefixFrom,
  type UrlPrefixState,
} from './urlprefix';
import {
  loadDomainText,
  sessionTextVec,
  textSim,
  vecOf,
  type DomainTextState,
} from './domaintext';
import { textCosine } from './textembed';
import { calibrateFrom, loadBlendCalib } from './blendcalib';
import { loadMlp, loadTransition, saveMlp, saveTransition } from './persistence';
import { clamp } from './math';

const FEATURE_COUNT = RECOMMEND_FEATURE_NAMES.length;
const CANDIDATE_POOL = 80;
const POOL_CAP = 120; // ceiling after candidate-generator expansion (Phase 3.4)
const MAX_SUGGESTIONS = 5;
const COLD_START_FRECENCY_FLOOR = 5;

const modelCache = lazy<OnlineLogReg>(() => loadRecommendModel(FEATURE_COUNT));
const banditCache = lazy<BetaBandit>(() => loadBandit('recommend'));
const seqCache = lazy<DomainSequenceMemory>(() => loadSequenceMemory());
const forestCache = lazy<RandomForest>(() => loadRecommendForest());
const transitionCache = lazy<TransitionModel>(() => loadTransition());
const mlpCache = lazy<TinyMLP>(() => loadMlp(FEATURE_COUNT));
// Phase 5 MLP is OFF by default — flipped via the debug panel after a
// backtest confirms it helps. Read from KV once and cached.
let mlpEnabled: boolean | null = null;

// Deferred saves (see ./flush). Each marks its blob dirty; one timer persists.
function persistModel(model: OnlineLogReg): void {
  markDirty('recommend.model', () => saveRecommendModel(model));
}
function persistBandit(bandit: BetaBandit): void {
  markDirty('recommend.bandit', () => saveBandit('recommend', bandit));
}
function persistTransition(t: TransitionModel): void {
  markDirty('recommend.transition', () => saveTransition(t));
}
function persistMlp(m: TinyMLP): void {
  markDirty('recommend.mlp', () => saveMlp(m));
}
function persistSeq(s: DomainSequenceMemory): void {
  markDirty('recommend.sequence', () => saveSequenceMemory(s));
}

function getTransition(): Promise<TransitionModel> {
  return transitionCache.get();
}
function getMlp(): Promise<TinyMLP> {
  return mlpCache.get();
}
async function isMlpEnabled(): Promise<boolean> {
  if (mlpEnabled === null) {
    const row = await db.kv.get('mlpEnabled:v1');
    mlpEnabled = row?.value === true;
  }
  return mlpEnabled;
}
export async function setMlpEnabled(on: boolean): Promise<void> {
  mlpEnabled = on;
  await db.kv.put({ key: 'mlpEnabled:v1', value: on, updatedAt: Date.now() });
}

export async function mlpStatus(): Promise<{ enabled: boolean; ready: boolean; trainedGroups: number }> {
  const m = await getMlp();
  return {
    enabled: await isMlpEnabled(),
    ready: m.isReady(FEATURE_COUNT),
    trainedGroups: m.state.trainedGroups,
  };
}

function getModel(): Promise<OnlineLogReg> {
  return modelCache.get();
}

function getBandit(): Promise<BetaBandit> {
  return banditCache.get();
}

export function getSequenceMemory(): Promise<DomainSequenceMemory> {
  return seqCache.get();
}

function getForest(): Promise<RandomForest> {
  return forestCache.get();
}

// Invalidate the forest cache so the next inference reloads from KV. The
// nightly trainer calls this after persisting a freshly-fit forest so that
// the SW (which may have already loaded an older forest into memory) picks
// up the new one without restart.
export function invalidateForestCache(): void {
  forestCache.reset();
}

// Sequence-memory + factorized-transition training on a raw TAB SWITCH
// (focus moved from one domain to another). Tab switches are ~10× more
// frequent than switch-opens and are exactly the "where does attention go
// next" signal both models encode. The transition model used to be trained
// only on switch-opens and was still at random init after 45 steps
// (factorizedTransition ≈ 0.5 ± 0.01 for every candidate — pure noise that
// the LR's standardization amplified into a full-scale feature).
export async function observeFocusTransition(
  prevHistory: string[],
  next: string,
  ts: number,
): Promise<void> {
  if (!next || prevHistory.length === 0) return;
  const hour = new Date(ts).getHours();
  const seq = await getSequenceMemory();
  seq.observe(prevHistory, next, ts, hour);
  persistSeq(seq);

  const from = prevHistory[prevHistory.length - 1];
  if (from && from !== next && !from.startsWith('chrome') && !next.startsWith('chrome')) {
    const transition = await getTransition();
    const negatives = transition.sampleNegatives(5, new Set([from, next]));
    transition.observe(from, next, negatives);
    persistTransition(transition);
  }
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
  // Timestamp the current browsing session started (first event after a
  // >30-min gap). Drives minutesIntoSession / isSessionStart (Phase 3.2).
  sessionStartTs?: number;
}

// Shared per-call context so the v8 features that don't vary by candidate
// (session vector, circadian snapshot, prefix table) are computed ONCE per
// scoring pass and read O(1) per candidate — respecting the perf budget.
interface ScoringContext {
  embedding: SkipGramEmbedding;
  bandit: BetaBandit;
  seq: DomainSequenceMemory;
  circadian: CircadianState;
  prefixes: UrlPrefixState;
  transition: TransitionModel;
  domainText: DomainTextState;
  sessionVec: Float64Array | null;
  sessionCohesion: number;
  sessionTextVec: Float32Array | null;
  focusHistory: string[];
  focusedDomain?: string;
  hour: number;
  dow: number;
  openDomains: string[];
  now: number;
  minutesIntoSession: number;
  isSessionStart: number;
}

// Compute the per-candidate v8 feature inputs from a shared scoring context.
// All O(1) against in-memory structures.
function v8FeatureInputs(ctx: ScoringContext, domain: string) {
  return {
    transitionAffinity: ctx.focusedDomain
      ? ctx.embedding.directedScore(ctx.focusedDomain, domain)
      : 0,
    sessionSim: ctx.sessionVec
      ? ctx.embedding.cosineToVector(domain, ctx.sessionVec)
      : 0,
    sessionCohesion: ctx.sessionCohesion,
    minutesIntoSession: ctx.minutesIntoSession,
    isSessionStart: ctx.isSessionStart,
    hourActivityZ: hourActivityZFrom(ctx.circadian, ctx.hour),
    banditLogit: ctx.bandit.logit(domain),
    prefixConcentration: topPrefixFrom(ctx.prefixes, domain).concentration,
    titleSimToFocused: ctx.focusedDomain
      ? textSim(ctx.domainText, domain, ctx.focusedDomain)
      : 0,
    titleSimToSession: ctx.sessionTextVec
      ? (() => {
          const v = vecOf(ctx.domainText, domain);
          return v ? textCosine(v, ctx.sessionTextVec!) : 0;
        })()
      : 0,
    factorizedTransition: ctx.focusedDomain
      ? ctx.transition.score(ctx.focusedDomain, domain)
      : 0.5,
    // v9: candidate-as-query attention over the recent focus history.
    dinAttention: dinAttention(ctx.embedding, ctx.focusHistory, domain),
  };
}

export async function recommendOpen(
  context: RecommendCallContext,
): Promise<OpenCandidate[]> {
  const ranked = await scoreOpenCandidates(context, { deterministic: false });
  return ranked.slice(0, MAX_SUGGESTIONS);
}

// Full scoring path, shared by the live recommender and the offline
// evaluator. `deterministic: true` disables exploration jitter so repeated
// evaluation runs are comparable. `modelOverride` lets the backtest
// evaluator score with a freshly-trained-on-a-split model instead of the
// live one.
export async function scoreOpenCandidates(
  context: RecommendCallContext,
  opts: {
    deterministic?: boolean;
    now?: number;
    modelOverride?: OnlineLogReg;
    forestOverride?: RandomForest | null;
  } = {},
): Promise<OpenCandidate[]> {
  const model = opts.modelOverride ?? (await getModel());
  const bandit = await getBandit();
  const embedding = await getEmbedding();
  const seq = await getSequenceMemory();
  const circadian = await loadCircadian();
  const prefixes = await loadUrlPrefixes();
  const transition = await getTransition();
  const domainText = await loadDomainText();
  const blendCalib = await loadBlendCalib();
  const forest =
    opts.forestOverride !== undefined ? opts.forestOverride : await getForest();
  const forestReady = !!forest && forest.isReady(FEATURE_COUNT);
  // Phase 5 MLP ensemble — only when the user has enabled it AND it's warm.
  const mlp = opts.modelOverride ? null : await getMlp();
  const useMlp = !opts.modelOverride && (await isMlpEnabled()) && !!mlp && mlp.isReady(FEATURE_COUNT);

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

  const now = opts.now ?? Date.now();
  const focusHistory = context.focusHistory ?? [];
  const focusedDomain = context.focusedDomain;

  // ── Session vector (computed ONCE, read O(1) per candidate) ───────
  const session = buildSessionVector(focusHistory, embedding, embedding.dim);

  // ── Candidate-pool augmentation (Phase 3.4) ───────────────────────
  // Frecency = "what you visit a lot, ever". We add what you tend to open
  // RIGHT NOW: (a) sequence-memory top transitions, (b) embedding neighbors
  // of the focused domain, (c) embedding neighbors of the session centroid.
  // All in-memory; capped at POOL_CAP to bound scoring cost. Without this,
  // the right next-domain is often not even in the list (measured by the
  // evaluator's recall@pool).
  const poolDomains = new Set(pool.map((p) => p.domain));
  const blankStat = (domain: string): DomainStats => ({
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
  });
  const tryAdd = async (domain: string) => {
    if (!domain || poolDomains.has(domain) || domain.startsWith('chrome')) return;
    if (pool.length >= POOL_CAP) return;
    pool.push((await getDomainStats(domain)) ?? blankStat(domain));
    poolDomains.add(domain);
  };
  for (const { domain } of seq.topPredictions(focusHistory, context.hour, now, 20)) {
    await tryAdd(domain);
  }
  if (focusedDomain) {
    for (const { domain } of embedding.topNeighbors(focusedDomain, 8)) await tryAdd(domain);
    // Factorized transition model's top next-domains (Phase 2.3) — generalizes
    // beyond observed (from→to) pairs, directly improving recall@pool.
    for (const domain of transition.topNext(focusedDomain, 8, poolDomains)) await tryAdd(domain);
  }
  if (session.vec) {
    for (const domain of embedding.nearestToVector(session.vec, 8, poolDomains)) {
      await tryAdd(domain);
    }
  }

  const openSet = new Set(context.openDomains);
  const pinnedSet = new Set(context.pinnedDomains ?? []);

  // Session-position (Phase 3.2).
  const sessionStartTs = context.sessionStartTs ?? now;
  const minutesIntoSession = clamp((now - sessionStartTs) / 60_000, 0, 120);
  const isSessionStart = now - sessionStartTs < 60_000 ? 1 : 0;

  // Shared scoring context for the O(1) v8 feature reads.
  const sctx: ScoringContext = {
    embedding,
    bandit,
    seq,
    circadian,
    prefixes,
    transition,
    domainText,
    sessionVec: session.vec,
    sessionCohesion: session.cohesion,
    sessionTextVec: sessionTextVec(domainText, focusHistory.slice(-8)),
    focusHistory,
    focusedDomain,
    hour: context.hour,
    dow: context.dow,
    openDomains: context.openDomains,
    now,
    minutesIntoSession,
    isSessionStart,
  };

  // One bulk events load answers visit-velocity, session-context, AND
  // last-seen-url/title for every candidate (1 query + in-memory maps).
  const snapshot = await buildTimeseriesSnapshot(now);

  const candidates: OpenCandidate[] = [];
  for (let i = 0; i < pool.length; i++) {
    const stat = pool[i];
    if (!stat.domain || stat.domain.startsWith('chrome')) continue;
    const embedSim = focusedDomain
      ? embedding.cosine(stat.domain, focusedDomain)
      : 0;
    const features = await buildRecommendFeatures({
      domain: stat.domain,
      context,
      // `pool` was bulk-loaded (getTopDomainsByFrecency = 1 query) + augmented
      // (blankStat fallback), so `stat` IS the DomainStats — pass it to skip a
      // redundant per-candidate getDomainStats (up to ~120 IDB gets/scoring).
      stats: stat,
      isCurrentlyOpen: openSet.has(stat.domain),
      isPinnedSomewhere: pinnedSet.has(stat.domain),
      embedSimToFocused: embedSim,
      visitVelocity: snapshot.velocityOf(stat.domain),
      sessionContext: snapshot.sessionOf(stat.domain),
      seqProbShort: seq.predictShort(focusHistory, stat.domain, now),
      seqProbLong: seq.predictLong(focusHistory, stat.domain, embedding),
      seqProbTime: seq.predictTime(focusHistory, stat.domain, context.hour),
      ...v8FeatureInputs(sctx, stat.domain),
      now,
    });
    if (features.isCurrentlyOpen) continue;
    const xVec = vectorFromRecommend(features);
    const lrScore = model.predict(xVec);
    // Ensemble: LR + RF (+ optional MLP). The bandit is now a LEARNED
    // feature (banditLogit) inside the models — no hard-coded multiplier.
    let score: number;
    if (useMlp && forestReady) {
      score = 0.4 * lrScore + 0.35 * forest!.predict(xVec) + 0.25 * mlp!.predict(xVec);
    } else if (forestReady) {
      score = 0.5 * lrScore + 0.5 * forest!.predict(xVec);
    } else {
      score = lrScore;
    }
    // Phase 4.2: calibrate the blended score against realized outcomes so
    // the OracleHint threshold compares a genuine probability. Monotonic —
    // ranking is unchanged.
    if (!opts.modelOverride) score = calibrateFrom(blendCalib, score);
    // Exploration: small additive jitter on the live path, decaying as the
    // arm accumulates impressions. Deterministic (eval) path: none.
    if (!opts.deterministic) {
      const eps = 0.08 / (1 + sctx.bandit.impressionsOf(stat.domain) / 10);
      score += eps * (Math.random() - 0.5);
    }
    if (isColdStart) {
      const positionBoost = 1 - i / Math.max(pool.length, 1);
      score = score * 0.4 + positionBoost * 0.6;
    }
    // URL surfacing (Phase 4.3): prefer the domain's top URL prefix (a
    // precise, actionable page) over the bare last-seen URL.
    const prefHit = topPrefixFrom(prefixes, stat.domain);
    const last = snapshot.lastSeenOf(stat.domain) ?? (await lastEventForDomain(stat.domain));
    const url = prefHit.url ?? last.url ?? `https://${stat.domain}`;
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
  return candidates;
}

export async function recordRecommendImpressions(
  candidates: OpenCandidate[],
): Promise<void> {
  const bandit = await getBandit();
  for (const c of candidates) bandit.recordImpression(banditArmId(c.domain));
  persistBandit(bandit);
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

  persistModel(model);
  persistBandit(bandit);
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
    // Domains focused/opened in the past 15 min (Phase 1.1 switch filter).
    recentlyFocusedDomains?: string[];
    sessionStartTs?: number;
    // Phase 1.3/1.4 sample weight (engagement × openedFrom), default 1.
    sampleWeight?: number;
    // Backtest evaluator trains a fresh model on a time split — when set,
    // train INTO this model and do NOT persist (the live model is untouched).
    modelOverride?: OnlineLogReg;
  },
): Promise<boolean> {
  if (!event.domain) return false;
  if (event.type !== 'open' && event.type !== 'navigate') return false;

  const focusHistory = ctx?.focusHistory ?? [];
  const focusedDomain = ctx?.focusedDomain;
  const openDomains = ctx?.openDomains ?? [];

  // ── Phase 1.1: switch-event filter ────────────────────────────────
  // The product predicts what to OPEN next, so it trains only on open/navigate
  // (focus events — switching between already-open tabs — feed context, not
  // positives). Two guards:
  //   1. Skip the domain already focused: predicting the page you're on is
  //      useless, and same-domain SPA navigation lands here too.
  //   2. Skip a domain opened in the last RECENT_FOCUS_MS: a rapid duplicate
  //      open, not new intent.
  // (2) used to be a 15-min window, which over-reached: returning to GitHub
  // after a few minutes on Slack is a genuine, predictable switch, not a
  // duplicate. Shrunk to 2 min so legitimate returns count as training and
  // prediction targets — high-frequency work switching is exactly what we
  // want to learn.
  if (event.domain === focusedDomain) return false;
  if (ctx?.recentlyFocusedDomains?.includes(event.domain)) return false;

  const model = ctx?.modelOverride ?? (await getModel());
  const embedding = await getEmbedding();
  const seq = await getSequenceMemory();
  const bandit = await getBandit();
  const circadian = await loadCircadian();
  const prefixes = await loadUrlPrefixes();
  const transition = await getTransition();
  const domainText = await loadDomainText();
  const hour = event.hourOfDay ?? new Date(event.ts).getHours();
  const dow = event.dayOfWeek ?? new Date(event.ts).getDay();

  // Session context shared by all group members (computed once).
  const session = buildSessionVector(focusHistory, embedding, embedding.dim);
  const sessTextVec = sessionTextVec(domainText, focusHistory.slice(-8));
  const sessionStartTs = ctx?.sessionStartTs ?? event.ts;
  const minutesIntoSession = clamp((event.ts - sessionStartTs) / 60_000, 0, 120);
  const isSessionStart = event.ts - sessionStartTs < 60_000 ? 1 : 0;

  const buildFor = async (domain: string, isCurrentlyOpen: boolean) => {
    const embedSim = focusedDomain ? embedding.cosine(domain, focusedDomain) : 0;
    const [vel, sess] = await Promise.all([
      visitVelocity(domain, event.ts),
      sessionContextFeature(domain, event.ts),
    ]);
    const dtVec = vecOf(domainText, domain);
    return buildRecommendFeatures({
      domain,
      context: { hour, dow, focusedDomain, openDomains },
      isCurrentlyOpen,
      isPinnedSomewhere: false,
      embedSimToFocused: embedSim,
      visitVelocity: vel,
      sessionContext: sess,
      seqProbShort: seq.predictShort(focusHistory, domain, event.ts),
      seqProbLong: seq.predictLong(focusHistory, domain, embedding),
      seqProbTime: seq.predictTime(focusHistory, domain, hour),
      // v8 features at train time — must mirror the scoring path exactly.
      transitionAffinity: focusedDomain ? embedding.directedScore(focusedDomain, domain) : 0,
      sessionSim: session.vec ? embedding.cosineToVector(domain, session.vec) : 0,
      sessionCohesion: session.cohesion,
      minutesIntoSession,
      isSessionStart,
      hourActivityZ: hourActivityZFrom(circadian, hour),
      banditLogit: bandit.logit(domain),
      prefixConcentration: topPrefixFrom(prefixes, domain).concentration,
      titleSimToFocused: focusedDomain ? textSim(domainText, domain, focusedDomain) : 0,
      titleSimToSession: sessTextVec && dtVec ? textCosine(dtVec, sessTextVec) : 0,
      factorizedTransition: focusedDomain ? transition.score(focusedDomain, domain) : 0.5,
      dinAttention: dinAttention(embedding, focusHistory, domain),
      now: event.ts,
    });
  };

  // ── Mixture negative sampling: 3 easy + 2 hard (see git history) ──
  const EASY_NEG_COUNT = 3;
  const HARD_NEG_COUNT = 2;

  // Serving never ranks a domain that's already open in a tab (see the
  // isCurrentlyOpen skip in scoreOpenCandidates), so neither may training:
  // open domains are excluded from the negatives.
  const exclude = new Set<string>([event.domain, ...openDomains]);
  if (focusedDomain) exclude.add(focusedDomain);

  const hardCandidates = seq
    .topPredictions(focusHistory, hour, event.ts, 10)
    .map((p) => p.domain)
    .filter((d) => d && !exclude.has(d) && !d.startsWith('chrome'))
    .slice(0, HARD_NEG_COUNT);
  for (const d of hardCandidates) exclude.add(d);

  const easyTarget = EASY_NEG_COUNT + (HARD_NEG_COUNT - hardCandidates.length);
  const allDomains = await db.domains.toArray();
  const easyPool = allDomains
    .map((d) => d.domain)
    .filter((d) => d && !exclude.has(d) && !d.startsWith('chrome'));
  const easySampled: string[] = [];
  {
    const arr = easyPool.slice();
    const k = Math.min(easyTarget, arr.length);
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(Math.random() * (arr.length - i));
      [arr[i], arr[j]] = [arr[j], arr[i]];
      easySampled.push(arr[i]);
    }
  }

  // ── Phase 2.1: build the group and take one softmax-CE ranking step ─
  // The positive's feature vector + all negatives' vectors form ONE group;
  // updateGroup pushes the positive's probability up relative to the rest
  // (learning-to-rank), instead of K independent binary updates.
  const negDomains = [...hardCandidates, ...easySampled];
  const group: Array<{ x: number[]; positive: boolean }> = [];
  // isCurrentlyOpen is 0 for every group member. It used to be hard-coded
  // TRUE for the positive (the tab that was just opened makes its own domain
  // "open") and mostly false for negatives — a target leak: the feature
  // literally encoded "this is the answer", grew to the 2nd-largest weight,
  // and starved the real features of gradient. At serve time it is always 0
  // (open domains are skipped), so 0 here is the only train/serve-consistent
  // value. The random-forest trainer already used false.
  const posFeatures = await buildFor(event.domain, false);
  group.push({ x: vectorFromRecommend(posFeatures), positive: true });
  for (const d of negDomains) {
    const negFeatures = await buildFor(d, false);
    group.push({ x: vectorFromRecommend(negFeatures), positive: false });
  }
  model.updateGroup(group, ctx?.sampleWeight ?? 1);

  // Backtest path trains only the LR override — leave the shared
  // transition/MLP/persistence untouched.
  if (ctx?.modelOverride) return true;

  // Phase 2.3: the factorized transition model also learns from this
  // (from→to, negatives) example; its main feed is every tab switch
  // (observeFocusTransition).
  if (focusedDomain) {
    transition.observe(focusedDomain, event.domain, negDomains);
    persistTransition(transition);
  }

  // Phase 5: keep the (off-by-default) MLP warm on the same group.
  try {
    const mlp = await getMlp();
    mlp.updateGroup(group, ctx?.sampleWeight ?? 1);
    persistMlp(mlp);
  } catch (err) {
    void logError('mlpTrain', err);
  }

  persistModel(model);
  return true;
}

export function clearSequenceMemoryCache(): void {
  seqCache.reset();
}

// Dwell-time feedback — called from the SW's tab-close handler. An open is
// only HALF the signal; what happened next tells us whether it was a good
// open. We route this through the bandit (per-domain posterior) rather than
// the LR because the LR's features describe the *context at open time*,
// which is long gone by close time — but the bandit is context-free, so a
// close-time nudge is well-defined:
//   - dwelled ≥ 60s            → soft accept (+0.3 α): the open paid off
//   - bounced (< 10s, 0 focus) → soft ignore (+0.3 β): the open was a miss
// Anything in between is ambiguous and gets no nudge.
export async function nudgeRecommendOnClose(args: {
  domain: string;
  focusMs: number;
  focusCount: number;
}): Promise<void> {
  const { domain, focusMs, focusCount } = args;
  if (!domain || domain.startsWith('chrome')) return;
  const bandit = await getBandit();
  if (focusMs >= 60_000) {
    bandit.recordSoftAccept(banditArmId(domain), 0.3);
  } else if (focusMs < 10_000 && focusCount === 0) {
    bandit.recordIgnore(banditArmId(domain), 0.3);
  } else {
    return; // ambiguous dwell — no update, skip the save
  }
  persistBandit(bandit);
}

export function clearRecommendCaches(): void {
  modelCache.reset();
  banditCache.reset();
  seqCache.reset();
  forestCache.reset();
  transitionCache.reset();
  mlpCache.reset();
  mlpEnabled = null;
}
