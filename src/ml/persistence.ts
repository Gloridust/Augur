import { db } from '../shared/db';
import { BetaBandit, type BanditState } from './models/bandit';
import { SkipGramEmbedding, type EmbeddingState } from './models/embedding';
import { OnlineLogReg, type LogRegState } from './models/logreg';
import { DomainSequenceMemory, type SequenceMemoryState } from './models/markov';
import { RandomForest, type ForestState } from './models/randomforest';

// v3 = expanded feature set (cyclic time, audible/discarded, tab position,
// window homogeneity, named groups, navCount, idle) + Adam optimizer
// state + L1. Bumping the key resets old saved weights so we don't
// silently mis-map indices; events stay intact and the model warms back
// up via incremental updates.
// v4 adds two embedding-cluster features (inActiveCluster, clusterStaleness)
const KV_CLEANUP_MODEL = 'model:cleanup:v4';
// v5 = same feature set as v4, but the implicit-training class weights
// were fixed (pos_weight 0.4 → 1.0) so the bias no longer drifts to -3.
// The v4 model's bias was baked in by Adam momentum and would take days
// to correct via organic gradient — bumping forces a clean re-fit via
// the auto-warmup path on update.
const KV_RECOMMEND_MODEL = 'model:recommend:v5';
const KV_SEQUENCE_MEMORY = 'sequenceMemory:v1';
const KV_RECOMMEND_FOREST = 'model:recommend:forest:v1';
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
