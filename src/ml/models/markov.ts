// Domain-level sequence memory with THREE timescales — short, long, time-of-day.
//
// Inspired by the LSTM intuition: short-term cell state (recent activity) and
// long-term cell state (stable patterns) coexist; the model learns when to
// trust which. Here we expose three independent count-based predictors as
// separate features to the LR head, which then learns the per-user mixing
// weights:
//
//   1. seqProbShort — exponentially-decayed transitions in the last ~30min.
//      Captures rapid back-and-forth between a small set of tabs in a hot
//      session. "I just toggled between Slack/Jira three times — predict
//      one of those three next."
//
//   2. seqProbLong — bigram + trigram counts that accumulate forever, with
//      embedding-smoothed backoff for unseen pairs. Captures stable
//      workflow patterns. "After Slack the user usually opens Linear."
//
//   3. seqProbTime — bigram conditioned on hour-of-day bucket. Captures
//      daily-rhythm habits. "Monday 9am the user always opens Gmail."
//
// All three update on the same `observe()` call. Predictors are independent
// reads — the LR head sees three numbers and learns the optimal mixture for
// THIS user. Chaotic users get high weight on `seqProbShort`; routinized
// users on `seqProbLong` / `seqProbTime`.
//
// At ~1000–10k events per user, this is the right form factor: O(1) updates,
// no backprop, no cold-start period. The transformer-style intuition
// (relevant-context-similar attention) is preserved via the embedding-
// smoothed long-term backoff.

import type { SkipGramEmbedding } from './embedding';

export interface SequenceMemoryState {
  // ── Long-term: bigram + trigram, no time decay ────────────────────
  bigram: Record<string, Record<string, number>>;            // last₁ → next → count
  trigram: Record<string, Record<string, number>>;           // "last₂|last₁" → next → count
  bigramTotal: Record<string, number>;
  trigramTotal: Record<string, number>;

  // ── Time-of-day-conditioned bigram ────────────────────────────────
  // Key format: `${hourBucket}|${last₁}`. Bucket = the hour itself
  // (0–23) for fine grain. Could be coarsened later (e.g. 6 buckets) if
  // tables grow too sparse.
  timeBigram: Record<string, Record<string, number>>;
  timeBigramTotal: Record<string, number>;

  // ── Short-term: rolling buffer of recent transitions ──────────────
  // Each entry: { ts: number, from: string, to: string }.
  // Capped at RECENCY_CAP — old entries fall off the end. This is the
  // "recurrent" piece: short-term cell state.
  recency: RecencyEntry[];

  // ── Global prior (deepest backoff) ────────────────────────────────
  globalCount: Record<string, number>;
  globalTotal: number;

  observations: number;
}

export interface RecencyEntry {
  ts: number;
  from: string;
  to: string;
}

const ALPHA = 0.5;             // Lidstone (additive) smoothing
const VOCAB_PRIOR = 200;       // pseudo-vocabulary size for smoothing denom
const TRIGRAM_FLOOR = 5;       // contexts with fewer obs fall back to bigram
const BIGRAM_FLOOR = 3;        // contexts with fewer obs fall back to global
const TIME_BIGRAM_FLOOR = 2;
const SIM_FLOOR = 0.3;         // cosine threshold for embedding smoothing
const SMOOTH_WEIGHT = 0.6;     // how much to trust borrowed mass vs prior

const RECENCY_CAP = 200;       // keep last 200 transitions in the buffer
const RECENCY_TAU_MS = 30 * 60 * 1000;        // 30-min half-life
const RECENCY_HORIZON_MS = 6 * 60 * 60 * 1000; // 6h cutoff (ignore older)

function hourKey(hour: number): string {
  return String(((hour % 24) + 24) % 24);
}

export class DomainSequenceMemory {
  state: SequenceMemoryState;

  constructor(state?: SequenceMemoryState) {
    this.state = state ?? {
      bigram: {},
      trigram: {},
      bigramTotal: {},
      trigramTotal: {},
      timeBigram: {},
      timeBigramTotal: {},
      recency: [],
      globalCount: {},
      globalTotal: 0,
      observations: 0,
    };
  }

  static load(raw: SequenceMemoryState | undefined): DomainSequenceMemory {
    if (!raw) return new DomainSequenceMemory();
    return new DomainSequenceMemory({
      bigram: raw.bigram ?? {},
      trigram: raw.trigram ?? {},
      bigramTotal: raw.bigramTotal ?? {},
      trigramTotal: raw.trigramTotal ?? {},
      timeBigram: raw.timeBigram ?? {},
      timeBigramTotal: raw.timeBigramTotal ?? {},
      recency: raw.recency ?? [],
      globalCount: raw.globalCount ?? {},
      globalTotal: raw.globalTotal ?? 0,
      observations: raw.observations ?? 0,
    });
  }

  serialize(): SequenceMemoryState {
    return this.state;
  }

  // Record one transition. `history` is the focus sequence ending right
  // before `next`. Pass at least one prior domain for any update; pass
  // two for trigram. `hour` is the hour of day at the time of the
  // transition (used by the time-of-day predictor).
  observe(history: string[], next: string, ts: number, hour: number): void {
    if (!next) return;
    const s = this.state;
    s.observations += 1;
    s.globalCount[next] = (s.globalCount[next] ?? 0) + 1;
    s.globalTotal += 1;

    if (history.length >= 1) {
      const a = history[history.length - 1];
      if (a && a !== next) {
        // ── Long-term bigram ─────────────────────────────────
        s.bigram[a] = s.bigram[a] ?? {};
        s.bigram[a][next] = (s.bigram[a][next] ?? 0) + 1;
        s.bigramTotal[a] = (s.bigramTotal[a] ?? 0) + 1;

        // ── Time-of-day bigram ───────────────────────────────
        const tk = `${hourKey(hour)}|${a}`;
        s.timeBigram[tk] = s.timeBigram[tk] ?? {};
        s.timeBigram[tk][next] = (s.timeBigram[tk][next] ?? 0) + 1;
        s.timeBigramTotal[tk] = (s.timeBigramTotal[tk] ?? 0) + 1;

        // ── Short-term recency buffer ────────────────────────
        s.recency.push({ ts, from: a, to: next });
        if (s.recency.length > RECENCY_CAP) {
          s.recency = s.recency.slice(-RECENCY_CAP);
        }
      }
    }
    if (history.length >= 2) {
      const a = history[history.length - 2];
      const b = history[history.length - 1];
      if (a && b && a !== next && b !== next) {
        const key = `${a}|${b}`;
        s.trigram[key] = s.trigram[key] ?? {};
        s.trigram[key][next] = (s.trigram[key][next] ?? 0) + 1;
        s.trigramTotal[key] = (s.trigramTotal[key] ?? 0) + 1;
      }
    }
  }

  // ── Long-term predictor ─────────────────────────────────────────
  // Backoff: trigram → bigram (with embedding smoothing) → global prior.
  predictLong(
    history: string[],
    candidate: string,
    embedding?: SkipGramEmbedding,
  ): number {
    if (!candidate) return 0;
    const s = this.state;

    if (history.length >= 2) {
      const key = `${history[history.length - 2]}|${history[history.length - 1]}`;
      const total = s.trigramTotal[key] ?? 0;
      if (total >= TRIGRAM_FLOOR) {
        const c = s.trigram[key]?.[candidate] ?? 0;
        return (c + ALPHA) / (total + ALPHA * VOCAB_PRIOR);
      }
    }

    if (history.length >= 1) {
      const last = history[history.length - 1];
      const total = s.bigramTotal[last] ?? 0;
      if (total >= BIGRAM_FLOOR) {
        const direct = s.bigram[last]?.[candidate] ?? 0;
        if (direct > 0) {
          return (direct + ALPHA) / (total + ALPHA * VOCAB_PRIOR);
        }
        if (embedding) {
          // Borrow mass from semantically similar partners — the
          // attention-over-similar-contexts trick.
          let smoothed = 0;
          const partners = s.bigram[last] ?? {};
          for (const [p, c] of Object.entries(partners)) {
            if (p === candidate) continue;
            const sim = embedding.cosine(candidate, p);
            if (sim > SIM_FLOOR) smoothed += sim * c;
          }
          return (smoothed * SMOOTH_WEIGHT + ALPHA) / (total + ALPHA * VOCAB_PRIOR);
        }
        return ALPHA / (total + ALPHA * VOCAB_PRIOR);
      }
    }

    if (s.globalTotal > 0) {
      const c = s.globalCount[candidate] ?? 0;
      return (c + ALPHA) / (s.globalTotal + ALPHA * VOCAB_PRIOR);
    }
    return 1 / VOCAB_PRIOR;
  }

  // ── Short-term predictor ────────────────────────────────────────
  // Walk the recency buffer, weight each transition by exp(−Δt/τ) where
  // τ = 30min. Returns hit-rate among recent transitions starting from
  // the same `from` domain. 0 means "no recent matches" (LR interprets
  // this as no signal).
  predictShort(history: string[], candidate: string, now: number): number {
    if (!candidate || history.length === 0) return 0;
    const last = history[history.length - 1];
    if (!last) return 0;

    const s = this.state;
    let weightedHits = 0;
    let weightedTotal = 0;
    for (const r of s.recency) {
      if (r.from !== last) continue;
      const dt = Math.max(0, now - r.ts);
      if (dt > RECENCY_HORIZON_MS) continue;
      const w = Math.exp(-dt / RECENCY_TAU_MS);
      weightedTotal += w;
      if (r.to === candidate) weightedHits += w;
    }
    if (weightedTotal === 0) return 0;
    // Tiny additive smoothing so a single hit isn't 1.0.
    return (weightedHits + 0.05) / (weightedTotal + 0.5);
  }

  // ── Time-of-day predictor ───────────────────────────────────────
  // P(candidate | last_domain, current_hour). Captures daily rhythms.
  predictTime(history: string[], candidate: string, hour: number): number {
    if (!candidate || history.length === 0) return 0;
    const last = history[history.length - 1];
    if (!last) return 0;

    const s = this.state;
    const key = `${hourKey(hour)}|${last}`;
    const total = s.timeBigramTotal[key] ?? 0;
    if (total < TIME_BIGRAM_FLOOR) return 0;
    const c = s.timeBigram[key]?.[candidate] ?? 0;
    return (c + ALPHA) / (total + ALPHA * VOCAB_PRIOR);
  }

  // Top-K likely next domains, used for CANDIDATE GENERATION (not just
  // ranking). Combines all three timescales — high-confidence picks
  // from any one path bubble up. Without this, the candidate pool stays
  // pure-frecency and the right domain may never be in the list to score.
  topPredictions(
    history: string[],
    hour: number,
    now: number,
    k: number,
  ): Array<{ domain: string; prob: number }> {
    const scores = new Map<string, number>();
    const s = this.state;
    const last = history.length >= 1 ? history[history.length - 1] : undefined;

    // Trigram (most specific — weight highest)
    if (history.length >= 2 && last) {
      const key = `${history[history.length - 2]}|${last}`;
      const total = s.trigramTotal[key] ?? 0;
      if (total >= TRIGRAM_FLOOR) {
        const partners = s.trigram[key] ?? {};
        for (const [d, c] of Object.entries(partners)) {
          scores.set(d, (scores.get(d) ?? 0) + (c / total) * 1.6);
        }
      }
    }

    // Bigram (long-term)
    if (last) {
      const total = s.bigramTotal[last] ?? 0;
      if (total >= BIGRAM_FLOOR) {
        const partners = s.bigram[last] ?? {};
        for (const [d, c] of Object.entries(partners)) {
          scores.set(d, (scores.get(d) ?? 0) + c / total);
        }
      }
    }

    // Time bigram (daily rhythm)
    if (last) {
      const tk = `${hourKey(hour)}|${last}`;
      const total = s.timeBigramTotal[tk] ?? 0;
      if (total >= TIME_BIGRAM_FLOOR) {
        const partners = s.timeBigram[tk] ?? {};
        for (const [d, c] of Object.entries(partners)) {
          scores.set(d, (scores.get(d) ?? 0) + (c / total) * 0.8);
        }
      }
    }

    // Recency (short-term burst)
    if (last) {
      const cutoff = now - RECENCY_HORIZON_MS;
      const burstScore = new Map<string, number>();
      let totalW = 0;
      for (const r of s.recency) {
        if (r.from !== last || r.ts < cutoff) continue;
        const w = Math.exp(-(now - r.ts) / RECENCY_TAU_MS);
        totalW += w;
        burstScore.set(r.to, (burstScore.get(r.to) ?? 0) + w);
      }
      if (totalW > 0) {
        for (const [d, w] of burstScore) {
          scores.set(d, (scores.get(d) ?? 0) + (w / totalW) * 1.2);
        }
      }
    }

    return Array.from(scores.entries())
      .map(([domain, prob]) => ({ domain, prob }))
      .sort((a, b) => b.prob - a.prob)
      .slice(0, k);
  }
}

