import { db, extractDomain } from '../shared/db';
import { logError } from '../shared/errorlog';
import type {
  DomainStats,
  OpenCandidate,
  RecommendFeatures,
  RecommendationContext,
  TabEvent,
} from '../shared/types';
import { getEmbedding } from './embedding-train';
import type { TimeseriesSnapshot } from './timeseries';
import {
  RECOMMEND_FEATURE_NAMES,
  RECOMMEND_WEIGHT_PRIOR,
  summarizeOpenReason,
  vectorFromRecommend,
} from './features';
import {
  buildCandidateFeatures,
  makeFeatureContext,
  type FeatureContext,
  type ModelBundle,
} from './candidate-features';
import { liveSource, servingSource, type AggregateSource } from './sources';
import { BetaBandit } from './models/bandit';
import { OnlineLogReg } from './models/logreg';
import {
  loadBandit,
  loadMlp,
  loadRecommendForest,
  loadRecommendModel,
  loadSequenceMemory,
  loadTransition,
  saveBandit,
  saveMlp,
  saveRecommendModel,
  saveSequenceMemory,
  saveTransition,
} from './persistence';
import { discardDirty, markDirty } from './flush';
import { lazy } from './lazy';
import { DomainSequenceMemory } from './models/markov';
import { RandomForest } from './models/randomforest';
import { TransitionModel } from './models/transition';
import { TinyMLP } from './models/mlp';
import { hourActivityZFrom, loadCircadian } from './circadian';
import { loadUrlPrefixes, topPrefixFrom } from './urlprefix';
import { loadDomainText } from './domaintext';
import { calibrateFrom, loadBlendCalib } from './blendcalib';
import { clamp } from './math';

const FEATURE_COUNT = RECOMMEND_FEATURE_NAMES.length;
const CANDIDATE_POOL = 80;
const POOL_CAP = 120; // ceiling after candidate-generator expansion (Phase 3.4)
const MAX_SUGGESTIONS = 5;
const COLD_START_FRECENCY_FLOOR = 5;
// Negatives per implicit training group, drawn from the serving pool.
const POOL_NEGATIVES = 8;
const FOREST_FULL_SHARE_ROWS = 14_000;

// The forest's say in the LR+forest blend grows with what it was fit on. A
// fixed 50/50 blend let a forest fit on ~200 switches (two weeks of data)
// pull the prior-anchored LR down (leak-free backtest MRR 0.18 → 0.16); it
// reaches its full half-share at ~2000 switches (× 7 rows each).
function forestShareOf(forest: RandomForest): number {
  return 0.5 * Math.min(1, forest.state.trainedSamples / FOREST_FULL_SHARE_ROWS);
}

const modelCache = lazy<OnlineLogReg>(() => loadRecommendModel(FEATURE_COUNT, RECOMMEND_WEIGHT_PRIOR));
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
  // Cold start only, and never allowed to stall a recommendation: a
  // topSites call that doesn't settle used to hang recommend.open forever.
  let sites: chrome.topSites.MostVisitedURL[] = [];
  try {
    sites = await Promise.race([
      chrome.topSites.get(),
      new Promise<chrome.topSites.MostVisitedURL[]>((resolve) => setTimeout(() => resolve([]), 500)),
    ]);
  } catch {
    return [];
  }
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
  return out;
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

// The live model bundle (cached singletons) for the shared feature builder.
export async function liveModels(): Promise<ModelBundle> {
  const [embedding, seq, transition, bandit, prefixes, domainText, circadian] = await Promise.all([
    getEmbedding(),
    getSequenceMemory(),
    getTransition(),
    getBandit(),
    loadUrlPrefixes(),
    loadDomainText(),
    loadCircadian(),
  ]);
  return {
    embedding,
    seq,
    transition,
    bandit,
    prefixes,
    domainText,
    hourActivityZ: (hour) => hourActivityZFrom(circadian, hour),
  };
}

export async function recommendOpen(
  context: RecommendCallContext,
): Promise<OpenCandidate[]> {
  const ranked = await scoreOpenCandidates(context, { deterministic: false });
  return ranked.slice(0, MAX_SUGGESTIONS);
}

// Score specific domains in the current context with the live ensemble and
// the shared feature builder (no exploration, no candidate generation). Used
// by the pin re-ranker, which previously read a stale model snapshot from
// storage and fed it a 11-of-30-feature vector.
export async function scoreDomains(
  context: RecommendCallContext,
  domains: string[],
): Promise<Map<string, number>> {
  const now = Date.now();
  const m = await liveModels();
  const { source } = await servingSource(now);
  const model = await getModel();
  const forest = await getForest();
  const forestReady = !!forest && forest.isReady(FEATURE_COUNT);
  const share = forestReady ? forestShareOf(forest!) : 0;
  const fc = makeFeatureContext(
    {
      ts: now,
      hour: context.hour,
      dow: context.dow,
      focusHistory: context.focusHistory ?? [],
      focusedDomain: context.focusedDomain,
      openDomains: context.openDomains,
      sessionStartTs: context.sessionStartTs,
    },
    m,
  );
  const pinnedSet = new Set(context.pinnedDomains ?? []);
  const out = new Map<string, number>();
  for (const d of domains) {
    const x = vectorFromRecommend(
      await buildCandidateFeatures(fc, d, source, m, { isPinnedSomewhere: pinnedSet.has(d) }),
    );
    const lr = model.predict(x);
    out.set(d, forestReady ? (1 - share) * lr + share * forest!.predict(x) : lr);
  }
  return out;
}

function blankStat(domain: string): DomainStats {
  return {
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
}

// The candidates the ranker chooses among at a moment — and therefore what
// training must contrast the opened domain with. Serving, live training,
// replay and the forest all draw from this one pool. (Training used to pit
// the target against uniform-random domains plus the sequence model's top
// guesses; the model learned that "the sequence model likes it" marks a
// NEGATIVE and never practised the real choice — recent vs popular within
// the pool — and on a leak-free backtest it lost to plain recency 2×.)
//
// strict: only domains with statistics at fc.ts, no cold-start top sites —
// for offline and training use, where anything else would be a guess or a
// future leak.
export async function candidatePool(
  fc: FeatureContext,
  src: AggregateSource,
  m: ModelBundle,
  opts: { evaluation?: boolean } = {},
): Promise<{ pool: DomainStats[]; isColdStart: boolean }> {
  const strict = opts.evaluation ?? false;
  const openSet = new Set(fc.openDomains);
  // A domain already open in a tab is never suggested (the user would switch
  // to it, not open it again), so it's excluded BEFORE taking the top-K — for
  // a heavy tab user, most top-frecency domains are open.
  const eligible = (d: string) => !!d && !d.startsWith('chrome') && !openSet.has(d) && d !== fc.focusedDomain;
  const pool: DomainStats[] = (await src.topByFrecency(CANDIDATE_POOL + openSet.size + 1))
    .filter((s) => eligible(s.domain))
    .slice(0, CANDIDATE_POOL);
  let isColdStart = false;
  if (!strict && pool.length < COLD_START_FRECENCY_FLOOR) {
    isColdStart = true;
    const seen = new Set(pool.map((p) => p.domain));
    for (const f of await topSitesPool()) {
      if (eligible(f.domain) && !seen.has(f.domain)) {
        pool.push(f);
        seen.add(f.domain);
      }
    }
  }

  // Augmentation (Phase 3.4): frecency = "what you visit a lot"; add what
  // you tend to open RIGHT NOW — sequence-memory transitions, embedding
  // neighbours of the focused domain, factorized-transition top-next, and
  // neighbours of the session centroid.
  const poolDomains = new Set(pool.map((p) => p.domain));
  const tryAdd = async (domain: string) => {
    if (!eligible(domain) || poolDomains.has(domain) || pool.length >= POOL_CAP) return;
    const stats = await src.stats(domain);
    if (!stats && strict) return;
    pool.push(stats ?? blankStat(domain));
    poolDomains.add(domain);
  };
  for (const { domain } of m.seq.topPredictions(fc.focusHistory, fc.hour, fc.ts, 20)) {
    await tryAdd(domain);
  }
  if (fc.focusedDomain) {
    for (const { domain } of m.embedding.topNeighbors(fc.focusedDomain, 8)) await tryAdd(domain);
    for (const domain of m.transition.topNext(fc.focusedDomain, 8, poolDomains)) await tryAdd(domain);
  }
  if (fc.session.vec) {
    for (const domain of m.embedding.nearestToVector(fc.session.vec, 8, poolDomains)) {
      await tryAdd(domain);
    }
  }
  return { pool, isColdStart };
}

// k distinct members of `pool` other than `exclude`, uniformly.
export function samplePoolNegatives(pool: DomainStats[], exclude: string, k: number): string[] {
  const xs = pool.map((p) => p.domain).filter((d) => d !== exclude);
  for (let i = 0; i < Math.min(k, xs.length); i++) {
    const j = i + Math.floor(Math.random() * (xs.length - i));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs.slice(0, k);
}

// Full scoring path, shared by the live recommender and the offline
// evaluator.
//   deterministic — no exploration jitter (evaluation runs must repeat).
//   modelOverride / forestOverride / mlpOverride — score with models trained
//     on a time split (backtest) instead of the live ones.
//   source / models — point-in-time aggregates + sequence/transition models
//     (evaluation of past events); default = live DB + live caches.
//   evaluation — skip cold-start top-sites and URL surfacing (ranking only).
export async function scoreOpenCandidates(
  context: RecommendCallContext,
  opts: {
    deterministic?: boolean;
    now?: number;
    modelOverride?: OnlineLogReg;
    forestOverride?: RandomForest | null;
    mlpOverride?: TinyMLP | null;
    source?: AggregateSource;
    models?: ModelBundle;
    evaluation?: boolean;
  } = {},
): Promise<OpenCandidate[]> {
  const now = opts.now ?? Date.now();
  const evaluation = opts.evaluation ?? false;
  const m = opts.models ?? (await liveModels());
  let src = opts.source;
  let snapshot: TimeseriesSnapshot | undefined;
  if (!src) ({ source: src, snapshot } = await servingSource(now));
  const model = opts.modelOverride ?? (await getModel());
  const blendCalib = await loadBlendCalib();
  const forest =
    opts.forestOverride !== undefined ? opts.forestOverride : await getForest();
  const forestReady = !!forest && forest.isReady(FEATURE_COUNT);
  const forestShare = forestReady ? forestShareOf(forest!) : 0;
  // Phase 5 MLP — live: only when enabled AND warm. Backtest: when the
  // evaluator passes a split-trained MLP (it does iff the user enabled it).
  const mlp =
    opts.mlpOverride !== undefined
      ? opts.mlpOverride
      : opts.modelOverride
        ? null
        : (await isMlpEnabled())
          ? await getMlp()
          : null;
  const useMlp = !!mlp && mlp.isReady(FEATURE_COUNT);

  const pinnedSet = new Set(context.pinnedDomains ?? []);
  const focusHistory = context.focusHistory ?? [];
  const fc = makeFeatureContext(
    {
      ts: now,
      hour: context.hour,
      dow: context.dow,
      focusHistory,
      focusedDomain: context.focusedDomain,
      openDomains: context.openDomains,
      sessionStartTs: context.sessionStartTs,
    },
    m,
  );

  const { pool, isColdStart } = await candidatePool(fc, src, m, { evaluation });

  const candidates: OpenCandidate[] = [];
  for (let i = 0; i < pool.length; i++) {
    const domain = pool[i].domain;
    const features = await buildCandidateFeatures(fc, domain, src, m, {
      isPinnedSomewhere: pinnedSet.has(domain),
    });
    const xVec = vectorFromRecommend(features);
    const lrScore = model.predict(xVec);
    // Ensemble: LR + RF (+ optional MLP). The bandit is a LEARNED feature
    // (banditLogit) inside the models — no hard-coded multiplier.
    let score: number;
    if (useMlp && forestReady) {
      const f = 0.35 * forestShare;
      score = (0.75 - f) * lrScore + f * forest!.predict(xVec) + 0.25 * mlp!.predict(xVec);
    } else if (forestReady) {
      score = (1 - forestShare) * lrScore + forestShare * forest!.predict(xVec);
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
      const eps = 0.08 / (1 + m.bandit.impressionsOf(domain) / 10);
      score += eps * (Math.random() - 0.5);
    }
    if (isColdStart) {
      const positionBoost = 1 - i / Math.max(pool.length, 1);
      score = score * 0.4 + positionBoost * 0.6;
    }
    let url = `https://${domain}`;
    let title = domain;
    if (!evaluation) {
      // URL surfacing (Phase 4.3): prefer the domain's top URL prefix (a
      // precise, actionable page) over the bare last-seen URL.
      const prefHit = topPrefixFrom(m.prefixes, domain);
      const last = snapshot?.lastSeenOf(domain) ?? (await lastEventForDomain(domain));
      url = prefHit.url ?? last.url ?? url;
      title = last.title ?? fallbackTitle(url, domain);
    }
    const reason = isColdStart && features.freqDecay <= 0.5
      ? 'popular'
      : summarizeOpenReason(features);
    candidates.push({
      domain,
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
    recentlyFocusedDomains?: string[];
    sessionStartTs?: number;
    // Phase 1.3/1.4 sample weight (engagement × openedFrom), default 1.
    sampleWeight?: number;
    // Backtest: train INTO these split-local models; nothing is persisted.
    modelOverride?: OnlineLogReg;
    mlpOverride?: TinyMLP;
    // Point-in-time aggregates + sequence/transition models when learning
    // from PAST events (replay, backtest). Default: live DB + live caches,
    // which is point-in-time for the live SW because it trains on an event
    // BEFORE writing it.
    source?: AggregateSource;
    models?: ModelBundle;
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
  //   2. Skip a domain seen in the last 2 min: a rapid duplicate open, not
  //      new intent. (Must be computed BEFORE the event is persisted — see
  //      logEvent in the SW.)
  if (event.domain === focusedDomain) return false;
  if (ctx?.recentlyFocusedDomains?.includes(event.domain)) return false;
  // Already open in another tab: serving never suggests an open domain, so
  // this is not an instance of the task the head is trained for.
  if (ctx?.openDomains?.includes(event.domain)) return false;

  const model = ctx?.modelOverride ?? (await getModel());
  const m = ctx?.models ?? (await liveModels());
  const src = ctx?.source ?? liveSource(event.ts);
  const fc = makeFeatureContext(
    {
      ts: event.ts,
      hour: event.hourOfDay,
      dow: event.dayOfWeek,
      focusHistory,
      focusedDomain,
      openDomains,
      sessionStartTs: ctx?.sessionStartTs,
    },
    m,
  );

  // ── Negatives: sampled from the serving candidate pool ──────────────
  // The model is trained to make the choice it is asked to make at serve
  // time — the opened domain against the other candidates the pool held at
  // that moment (open and focused domains are never in it).
  const { pool } = await candidatePool(fc, src, m, { evaluation: true });
  const negDomains = samplePoolNegatives(pool, event.domain, POOL_NEGATIVES);
  // A ranking step needs something to rank against.
  if (negDomains.length === 0) return false;

  // ── Phase 2.1: build the group and take one softmax-CE ranking step ─
  // isCurrentlyOpen is 0 for every member: it used to be hard-coded TRUE for
  // the positive (the just-opened tab makes its own domain "open") — a target
  // leak that grew to the 2nd-largest weight. At serve time it's always 0
  // (open domains are skipped), so 0 is the only consistent value.
  const group: Array<{ x: number[]; positive: boolean }> = [];
  for (const [domain, positive] of [[event.domain, true] as const, ...negDomains.map((d) => [d, false] as const)]) {
    const f = await buildCandidateFeatures(fc, domain, src, m);
    group.push({ x: vectorFromRecommend(f), positive });
  }
  const weight = ctx?.sampleWeight ?? 1;
  model.updateGroup(group, weight);
  ctx?.mlpOverride?.updateGroup(group, weight);
  if (ctx?.modelOverride) return true; // backtest: nothing shared is touched

  // Phase 5: keep the (off-by-default) MLP warm on the same group.
  try {
    const mlp = await getMlp();
    mlp.updateGroup(group, weight);
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

// Install a sequence memory / transition model rebuilt by a point-in-time
// replay of the whole log as the live one. Any pending write of the old
// in-memory copy is dropped first, or it would land on top of the new one.
export async function adoptSequenceMemory(seq: DomainSequenceMemory): Promise<void> {
  discardDirty('recommend.sequence');
  await saveSequenceMemory(seq);
  seqCache.reset();
}

export async function adoptTransition(t: TransitionModel): Promise<void> {
  discardDirty('recommend.transition');
  await saveTransition(t);
  transitionCache.reset();
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
