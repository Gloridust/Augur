import { db } from '../shared/db';
import { BetaBandit, type BanditState } from './models/bandit';
import { SkipGramEmbedding, type EmbeddingState } from './models/embedding';
import { OnlineLogReg, type LogRegState } from './models/logreg';
import { DomainSequenceMemory, type SequenceMemoryState } from './models/markov';
import { RandomForest, type ForestState } from './models/randomforest';
import { TransitionModel, type TransitionState } from './models/transition';
import { TinyMLP, type MlpState } from './models/mlp';

// v3 = expanded feature set (cyclic time, audible/discarded, tab position,
// window homogeneity, named groups, navCount, idle) + Adam optimizer
// state + L1. Bumping the key resets old saved weights so we don't
// silently mis-map indices; events stay intact and the model warms back
// up via incremental updates.
// v4 adds two embedding-cluster features (inActiveCluster, clusterStaleness)
const KV_CLEANUP_MODEL = 'model:cleanup:v4';
// v5 fixed class-weight imbalance; v6 fixed top-frecency-only negative
// sampling ("popular = negative" shortcut). v7 switches to MIXTURE
// sampling — 3 easy (uniform over db.domains) + 2 hard (the sequence
// model's own top predictions that the user did NOT open). Easy-only
// negatives (v6) taught the model to separate plausible-vs-random, but
// the live candidate pool is all-plausible — the product decision is
// "which of several plausible candidates", and only hard negatives train
// that boundary. Bumping forces a clean re-fit via auto-warmup on update
// so no v5/v6-era gradients linger in the Adam state.
// v8 = +8 features (directional transitionAffinity, sessionSim/cohesion,
// session-position, hourActivityZ, banditLogit, prefixConcentration) AND a
// ranking objective change: trainImplicitOpen now uses group-wise sampled
// softmax (learning-to-rank) instead of pointwise binary updates, and the
// switch-event training filter (only "new-intent" opens count). The
// multiplicative bandit blend is gone — the bandit is a learned feature
// now. Bumping resets the Adam/weight state so the new objective trains
// clean; auto-warmup re-fits from the existing event log on update.
const KV_RECOMMEND_MODEL = 'model:recommend:v8';
const KV_SEQUENCE_MEMORY = 'sequenceMemory:v1';
const KV_RECOMMEND_FOREST = 'model:recommend:forest:v2'; // feature shape changed
const KV_EVAL_HISTORY = 'evalHistory:v1';
const KV_TRANSITION = 'transition:v1';
const KV_MLP = 'model:recommend:mlp:v1';
const KV_CLEANUP_BANDIT = 'bandit:cleanup:v1';
const KV_RECOMMEND_BANDIT = 'bandit:recommend:v1';
const KV_EMBEDDING = 'embedding:v1';
const KV_LAST_AGGREGATE = 'lastAggregateAt';
const KV_LAST_EMBED_TRAIN = 'lastEmbedTrainAt';

async function loadKV<T>(key: string): Promise<T | undefined> {
  const row = await db.kv.get(key);
  return row?.value as T | undefined;
}

async function saveKV(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value, updatedAt: Date.now() });
}

export async function loadCleanupModel(featureCount: number): Promise<OnlineLogReg> {
  const raw = await loadKV<LogRegState>(KV_CLEANUP_MODEL);
  if (raw && raw.weights.length === featureCount) return OnlineLogReg.load(raw);
  // Adam-friendly defaults: smaller base lr (Adam's effective step is larger
  // than vanilla SGD), small L2 for shrinkage, small L1 for sparsity.
  const m = new OnlineLogReg(featureCount, { lr: 0.01, l2: 1e-4, l1: 1e-5 });
  m.setPriorRate(0.15);
  return m;
}

export async function saveCleanupModel(model: OnlineLogReg): Promise<void> {
  await saveKV(KV_CLEANUP_MODEL, model.serialize());
}

export async function loadRecommendModel(featureCount: number): Promise<OnlineLogReg> {
  const raw = await loadKV<LogRegState>(KV_RECOMMEND_MODEL);
  if (raw && raw.weights.length === featureCount) return OnlineLogReg.load(raw);
  const m = new OnlineLogReg(featureCount, { lr: 0.01, l2: 1e-4, l1: 1e-5 });
  m.setPriorRate(0.25);
  return m;
}

export async function saveRecommendModel(model: OnlineLogReg): Promise<void> {
  await saveKV(KV_RECOMMEND_MODEL, model.serialize());
}

export async function loadBandit(kind: 'cleanup' | 'recommend'): Promise<BetaBandit> {
  const key = kind === 'cleanup' ? KV_CLEANUP_BANDIT : KV_RECOMMEND_BANDIT;
  const raw = await loadKV<BanditState>(key);
  return new BetaBandit(raw);
}

export async function saveBandit(kind: 'cleanup' | 'recommend', bandit: BetaBandit): Promise<void> {
  const key = kind === 'cleanup' ? KV_CLEANUP_BANDIT : KV_RECOMMEND_BANDIT;
  await saveKV(key, bandit.serialize());
}

export async function getLastAggregateAt(): Promise<number> {
  return (await loadKV<number>(KV_LAST_AGGREGATE)) ?? 0;
}

export async function setLastAggregateAt(ts: number): Promise<void> {
  await saveKV(KV_LAST_AGGREGATE, ts);
}

export async function loadEmbedding(): Promise<SkipGramEmbedding> {
  const raw = await loadKV<EmbeddingState>(KV_EMBEDDING);
  return new SkipGramEmbedding(raw);
}

export async function saveEmbedding(emb: SkipGramEmbedding): Promise<void> {
  await saveKV(KV_EMBEDDING, emb.serialize());
  await saveKV(KV_LAST_EMBED_TRAIN, emb.serialize().updatedAt);
}

export async function getLastEmbedTrainAt(): Promise<number> {
  return (await loadKV<number>(KV_LAST_EMBED_TRAIN)) ?? 0;
}

export async function loadSequenceMemory(): Promise<DomainSequenceMemory> {
  const raw = await loadKV<SequenceMemoryState>(KV_SEQUENCE_MEMORY);
  return DomainSequenceMemory.load(raw);
}

export async function saveSequenceMemory(mem: DomainSequenceMemory): Promise<void> {
  await saveKV(KV_SEQUENCE_MEMORY, mem.serialize());
}

export async function loadRecommendForest(): Promise<RandomForest> {
  const raw = await loadKV<ForestState>(KV_RECOMMEND_FOREST);
  return RandomForest.load(raw);
}

export async function saveRecommendForest(forest: RandomForest): Promise<void> {
  await saveKV(KV_RECOMMEND_FOREST, forest.serialize());
}

// Eval-history lab notebook (Phase 0.2). A capped ring of past evaluation
// runs so model tuning is a measured longitudinal process that survives
// across sessions. Each entry records the metrics + the model version, so
// you can see whether a version bump actually moved the numbers.
export interface EvalHistoryEntry {
  ts: number;
  mode: 'replay' | 'backtest';
  sample: number;
  modelVersion: string;
  note?: string;
  model: { hit1: number; hit3: number; hit5: number; mrr: number; recallAtPool: number };
  baseline: { hit1: number; hit3: number; hit5: number; mrr: number };
}
const EVAL_HISTORY_CAP = 50;

export async function loadEvalHistory(): Promise<EvalHistoryEntry[]> {
  return (await loadKV<EvalHistoryEntry[]>(KV_EVAL_HISTORY)) ?? [];
}

export async function appendEvalHistory(entry: EvalHistoryEntry): Promise<void> {
  const hist = await loadEvalHistory();
  hist.push(entry);
  const trimmed = hist.slice(-EVAL_HISTORY_CAP);
  await saveKV(KV_EVAL_HISTORY, trimmed);
}

// The current recommend-model version string, for stamping eval-history
// entries. Kept here next to the key so they can't drift.
export const RECOMMEND_MODEL_VERSION = KV_RECOMMEND_MODEL;

export async function loadTransition(): Promise<TransitionModel> {
  return TransitionModel.load(await loadKV<TransitionState>(KV_TRANSITION));
}
export async function saveTransition(m: TransitionModel): Promise<void> {
  await saveKV(KV_TRANSITION, m.serialize());
}

export async function loadMlp(inDim: number): Promise<TinyMLP> {
  return TinyMLP.load(await loadKV<MlpState>(KV_MLP), inDim);
}
export async function saveMlp(m: TinyMLP): Promise<void> {
  await saveKV(KV_MLP, m.serialize());
}
