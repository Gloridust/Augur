import { db } from '../shared/db';
import { SkipGramEmbedding } from './models/embedding';
import { loadEmbedding, saveEmbedding } from './persistence';
import { lazy } from './lazy';

const MAX_STEPS_PER_BATCH = 8000;
const SUBSAMPLE_THRESHOLD = 1.0;

const cache = lazy<SkipGramEmbedding>(() => loadEmbedding());

export function getEmbedding(): Promise<SkipGramEmbedding> {
  return cache.get();
}

export function clearEmbeddingCache(): void {
  cache.reset();
}

// Train batch from the cooccurrence table. The pair counts already encode
// "how often these two domains were opened within 5 minutes of each other",
// so we can train directly on the aggregate without rescanning the event log.
//
// Training budget is capped per call so the alarm-triggered run completes
// within service-worker compute limits.
export async function trainEmbeddingBatch(now: number = Date.now()): Promise<{
  steps: number;
  vocab: number;
}> {
  const emb = await getEmbedding();
  const steps = trainEmbeddingOnPairs(emb, await db.cooccurrence.toArray());
  emb.markTrained(now);
  await saveEmbedding(emb);
  return { steps, vocab: emb.vocabSize() };
}

// One budgeted SGD pass over co-occurrence pairs. Pure (no I/O), shared with
// the backtest, which trains an embedding on pre-split pairs only.
export function trainEmbeddingOnPairs(
  emb: SkipGramEmbedding,
  pairs: Array<{ a: string; b: string; count: number }>,
  rng: () => number = Math.random,
): number {
  if (pairs.length === 0) return 0;
  // Pre-register all domains so the negative sampler has a meaningful pool
  // from the very first step.
  for (const p of pairs) {
    emb.ensure(p.a);
    emb.ensure(p.b);
  }
  let totalWeight = 0;
  for (const p of pairs) totalWeight += p.count;
  if (totalWeight <= 0) return 0;

  const stepBudget = Math.min(MAX_STEPS_PER_BATCH, Math.max(200, Math.round(totalWeight * 4)));
  // Shuffle pair order so SGD doesn't drift if the table is already sorted.
  const shuffled = pairs
    .map((p) => ({ p, k: rng() }))
    .sort((x, y) => x.k - y.k)
    .map((x) => x.p);

  let steps = 0;
  outer: while (steps < stepBudget) {
    for (const p of shuffled) {
      if (steps >= stepBudget) break outer;
      // Subsample very high-frequency pairs (Mikolov et al. trick).
      const f = p.count / totalWeight;
      const keep = Math.min(1, Math.sqrt(SUBSAMPLE_THRESHOLD / Math.max(f, 1e-6)));
      if (rng() > keep) continue;
      // Train both directions — co-occurrence is symmetric.
      emb.step(p.a, p.b, 1);
      emb.step(p.b, p.a, 1);
      steps += 2;
    }
  }
  return steps;
}
