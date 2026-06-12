// Offline replay evaluation for the recommend head.
//
// Walks the event log chronologically, reconstructs the focus-history
// context that existed before each historical "open", asks the CURRENT
// model to rank candidates for that context, and checks where the domain
// the user actually opened landed in the ranking. Reports hit@1 / hit@3 /
// hit@5 / MRR for the model AND for a pure-frecency baseline, so we can
// see whether the ML stack is actually beating the naive ranking.
//
// Honest caveats (also surfaced in the debug panel):
//   - This is REPLAY evaluation, not a held-out backtest. The current
//     model has already trained on these events, so absolute numbers are
//     optimistic. The value is in RELATIVE comparison: run it before and
//     after a model change and look at the delta.
//   - Aggregates (domain stats, embeddings, sequence memory) are evaluated
//     at their CURRENT state, not as-of each event. Time-series features
//     (velocity / session-context) ARE computed as-of each event, since
//     the snapshot accepts a historical `now`.
//
// Runtime: each test point costs one bulk events load (the timeseries
// snapshot) + ~100 candidate scorings. Default 60 points keeps a typical
// run in the low seconds on a 16k-event log.

import { db } from '../shared/db';
import type { TabEvent } from '../shared/types';
import { getTopDomainsByFrecency } from './aggregate';
import { scoreOpenCandidates } from './recommend';

export interface EvalMetrics {
  hit1: number;
  hit3: number;
  hit5: number;
  mrr: number;
}

export interface EvalReport {
  evaluated: number;
  skipped: number;
  model: EvalMetrics;
  baseline: EvalMetrics;
  tookMs: number;
}

interface TestPoint {
  event: TabEvent;
  focusHistory: string[];
}

const FOCUS_HISTORY_MAX = 8;

function emptyMetrics(): { hits1: number; hits3: number; hits5: number; rrSum: number } {
  return { hits1: 0, hits3: 0, hits5: 0, rrSum: 0 };
}

function finalize(
  acc: { hits1: number; hits3: number; hits5: number; rrSum: number },
  n: number,
): EvalMetrics {
  if (n === 0) return { hit1: 0, hit3: 0, hit5: 0, mrr: 0 };
  return {
    hit1: acc.hits1 / n,
    hit3: acc.hits3 / n,
    hit5: acc.hits5 / n,
    mrr: acc.rrSum / n,
  };
}

function record(
  acc: { hits1: number; hits3: number; hits5: number; rrSum: number },
  rank: number, // 1-based; Infinity = not in list
): void {
  if (rank <= 1) acc.hits1 += 1;
  if (rank <= 3) acc.hits3 += 1;
  if (rank <= 5) acc.hits5 += 1;
  if (Number.isFinite(rank)) acc.rrSum += 1 / rank;
}

export async function evaluateRecommend(sample = 60): Promise<EvalReport> {
  const t0 = Date.now();

  // ── 1. Collect test points by replaying the event log ─────────────
  const events = await db.events.orderBy('ts').toArray();
  const focusHistory: string[] = [];
  const points: TestPoint[] = [];

  for (const e of events) {
    if (e.type === 'focus' && e.domain && e.tabId !== undefined) {
      if (focusHistory[focusHistory.length - 1] !== e.domain) {
        focusHistory.push(e.domain);
        if (focusHistory.length > FOCUS_HISTORY_MAX) focusHistory.shift();
      }
      continue;
    }
    if (e.type !== 'open' && e.type !== 'navigate') continue;
    if (!e.domain || e.tabId === undefined) continue;
    const meta = e.meta as Record<string, unknown> | undefined;
    if (meta?.source === 'history-bootstrap') continue;
    // Need at least some context, and skip the trivial self-transition
    // (predicting "the domain you're already focused on" is not a test).
    const focused = focusHistory[focusHistory.length - 1];
    if (focusHistory.length >= 1 && e.domain !== focused) {
      points.push({ event: e, focusHistory: [...focusHistory] });
    }
  }

  const testSet = points.slice(-Math.max(1, sample));
  const skipped = points.length - testSet.length;

  // ── 2. Baseline ranking: pure frecency order (computed once) ──────
  const frecency = await getTopDomainsByFrecency(100);
  const frecencyRank = new Map<string, number>();
  frecency.forEach((d, i) => frecencyRank.set(d.domain, i + 1));

  // ── 3. Score every test point with the current model ──────────────
  const modelAcc = emptyMetrics();
  const baseAcc = emptyMetrics();
  let evaluated = 0;

  for (const p of testSet) {
    const e = p.event;
    const hour = e.hourOfDay ?? new Date(e.ts).getHours();
    const dow = e.dayOfWeek ?? new Date(e.ts).getDay();
    const focusedDomain = p.focusHistory[p.focusHistory.length - 1];

    let ranked;
    try {
      ranked = await scoreOpenCandidates(
        {
          hour,
          dow,
          focusedDomain,
          // Deliberately empty: the live recommender excludes already-open
          // domains, but for ranking-quality measurement the target must
          // remain rankable.
          openDomains: [],
          pinnedDomains: [],
          focusHistory: p.focusHistory,
        },
        { deterministic: true, now: e.ts },
      );
    } catch {
      continue; // a single bad point shouldn't kill the whole run
    }

    const target = e.domain!; // collection loop guarantees non-empty
    const idx = ranked.findIndex((c) => c.domain === target);
    record(modelAcc, idx >= 0 ? idx + 1 : Infinity);
    record(baseAcc, frecencyRank.get(target) ?? Infinity);
    evaluated += 1;
  }

  return {
    evaluated,
    skipped,
    model: finalize(modelAcc, evaluated),
    baseline: finalize(baseAcc, evaluated),
    tookMs: Date.now() - t0,
  };
}
