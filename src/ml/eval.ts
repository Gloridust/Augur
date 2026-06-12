// Offline evaluation for the recommend head — replay and backtest.
//
// REPLAY (default): walks the event log, reconstructs the focus-history
// context before each historical switch-open, asks the CURRENT model to
// rank candidates, and checks where the actually-opened domain landed.
// Reports hit@1/3/5 + MRR + recall@pool vs a frecency baseline. The model
// has already trained on these events, so absolute numbers are optimistic
// — the value is the RELATIVE delta before/after a change.
//
// BACKTEST: trains a FRESH model on events before a time split, then
// evaluates on events after it — a genuine generalization number, no
// leakage. Slower (run on demand). Aggregates/embeddings/sequence memory
// stay at their current state (documented approximation; only the LR is
// retrained on the split).
//
// recall@pool = fraction of test points whose target was in the candidate
// pool AT ALL. Separates "ranking failed" from "candidate generation
// failed" — they need different fixes.

import { db } from '../shared/db';
import type { TabEvent } from '../shared/types';
import { getTopDomainsByFrecency } from './aggregate';
import { RECOMMEND_FEATURE_NAMES } from './features';
import { OnlineLogReg } from './models/logreg';
import { scoreOpenCandidates, trainImplicitOpen } from './recommend';
import {
  appendEvalHistory,
  RECOMMEND_MODEL_VERSION,
} from './persistence';

export interface EvalMetrics {
  hit1: number;
  hit3: number;
  hit5: number;
  mrr: number;
}

export interface EvalReport {
  mode: 'replay' | 'backtest';
  evaluated: number;
  skipped: number;
  model: EvalMetrics & { recallAtPool: number };
  baseline: EvalMetrics;
  tookMs: number;
}

interface TestPoint {
  event: TabEvent;
  focusHistory: string[];
  sessionStartTs: number;
}

const FOCUS_HISTORY_MAX = 8;
const SESSION_GAP_MS = 30 * 60 * 1000;
const RECENT_FOCUS_MS = 15 * 60 * 1000;

function emptyAcc() {
  return { hits1: 0, hits3: 0, hits5: 0, rrSum: 0, inPool: 0 };
}
function record(acc: ReturnType<typeof emptyAcc>, rank: number, inPool: boolean): void {
  if (rank <= 1) acc.hits1 += 1;
  if (rank <= 3) acc.hits3 += 1;
  if (rank <= 5) acc.hits5 += 1;
  if (Number.isFinite(rank)) acc.rrSum += 1 / rank;
  if (inPool) acc.inPool += 1;
}

// Collect chronological switch-open test points, tracking the focus history
// and session start as they were at each point in time.
function collectPoints(events: TabEvent[]): TestPoint[] {
  const focusHistory: string[] = [];
  const recentFocus: Array<{ domain: string; ts: number }> = [];
  const points: TestPoint[] = [];
  let sessionStartTs = events[0]?.ts ?? Date.now();
  let lastEventTs = sessionStartTs;

  for (const e of events) {
    if (e.ts - lastEventTs > SESSION_GAP_MS) sessionStartTs = e.ts;
    lastEventTs = e.ts;
    if (e.type === 'focus' && e.domain && e.tabId !== undefined) {
      if (focusHistory[focusHistory.length - 1] !== e.domain) {
        focusHistory.push(e.domain);
        if (focusHistory.length > FOCUS_HISTORY_MAX) focusHistory.shift();
      }
      recentFocus.push({ domain: e.domain, ts: e.ts });
      continue;
    }
    if (e.type !== 'open' && e.type !== 'navigate') continue;
    if (!e.domain || e.tabId === undefined) continue;
    const meta = e.meta as Record<string, unknown> | undefined;
    if (meta?.source === 'history-bootstrap') continue;
    while (recentFocus.length && e.ts - recentFocus[0].ts > RECENT_FOCUS_MS) {
      recentFocus.shift();
    }
    const focused = focusHistory[focusHistory.length - 1];
    const recentSet = new Set(recentFocus.map((r) => r.domain));
    // Only switch-events are test points (matches training distribution).
    if (focusHistory.length >= 1 && e.domain !== focused && !recentSet.has(e.domain)) {
      points.push({ event: e, focusHistory: [...focusHistory], sessionStartTs });
    }
    if (e.domain) recentFocus.push({ domain: e.domain, ts: e.ts });
  }
  return points;
}

export async function evaluateRecommend(opts: {
  mode?: 'replay' | 'backtest';
  sample?: number;
  splitDays?: number;
  note?: string;
  persist?: boolean;
} = {}): Promise<EvalReport> {
  const t0 = Date.now();
  const mode = opts.mode ?? 'replay';
  const sample = Math.max(1, opts.sample ?? 60);

  const events = await db.events.orderBy('ts').toArray();
  const allPoints = collectPoints(events);

  // For backtest: train a fresh model on pre-split events, test on post-split.
  let modelOverride: OnlineLogReg | undefined;
  let testPoints: TestPoint[];

  if (mode === 'backtest') {
    const splitTs = Date.now() - (opts.splitDays ?? 7) * 24 * 60 * 60 * 1000;
    const fresh = new OnlineLogReg(RECOMMEND_FEATURE_NAMES.length, {
      lr: 0.01,
      l2: 1e-4,
      l1: 1e-5,
    });
    fresh.setPriorRate(0.25);
    // Replay-train the fresh model on switch-opens BEFORE the split. Cap to
    // the most recent N pre-split points so an on-demand backtest stays in
    // the low seconds (each point does a domains scan + per-candidate stat
    // lookups).
    const trainEvents = events.filter((e) => e.ts < splitTs);
    const trainPoints = collectPoints(trainEvents).slice(-1000);
    for (const p of trainPoints) {
      await trainImplicitOpen(p.event, {
        focusHistory: p.focusHistory,
        focusedDomain: p.focusHistory[p.focusHistory.length - 1],
        openDomains: p.focusHistory,
        sessionStartTs: p.sessionStartTs,
        modelOverride: fresh,
      });
    }
    modelOverride = fresh;
    testPoints = allPoints.filter((p) => p.event.ts >= splitTs).slice(-sample);
  } else {
    testPoints = allPoints.slice(-sample);
  }

  const skipped = allPoints.length - testPoints.length;

  // Frecency baseline (computed once).
  const frecency = await getTopDomainsByFrecency(100);
  const frecencyRank = new Map<string, number>();
  frecency.forEach((d, i) => frecencyRank.set(d.domain, i + 1));

  const modelAcc = emptyAcc();
  const baseAcc = emptyAcc();
  let evaluated = 0;

  for (const p of testPoints) {
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
          openDomains: [],
          pinnedDomains: [],
          focusHistory: p.focusHistory,
          sessionStartTs: p.sessionStartTs,
        },
        { deterministic: true, now: e.ts, modelOverride },
      );
    } catch {
      continue;
    }

    const target = e.domain!;
    const idx = ranked.findIndex((c) => c.domain === target);
    record(modelAcc, idx >= 0 ? idx + 1 : Infinity, idx >= 0);
    record(baseAcc, frecencyRank.get(target) ?? Infinity, frecencyRank.has(target));
    evaluated += 1;
  }

  const n = Math.max(1, evaluated);
  const report: EvalReport = {
    mode,
    evaluated,
    skipped,
    model: {
      hit1: modelAcc.hits1 / n,
      hit3: modelAcc.hits3 / n,
      hit5: modelAcc.hits5 / n,
      mrr: modelAcc.rrSum / n,
      recallAtPool: modelAcc.inPool / n,
    },
    baseline: {
      hit1: baseAcc.hits1 / n,
      hit3: baseAcc.hits3 / n,
      hit5: baseAcc.hits5 / n,
      mrr: baseAcc.rrSum / n,
    },
    tookMs: Date.now() - t0,
  };

  if (opts.persist !== false && evaluated > 0) {
    await appendEvalHistory({
      ts: Date.now(),
      mode,
      sample: evaluated,
      modelVersion: RECOMMEND_MODEL_VERSION,
      note: opts.note,
      model: report.model,
      baseline: report.baseline,
    });
  }

  return report;
}
