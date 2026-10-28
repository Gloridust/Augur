// Offline evaluation for the recommend head — replay and backtest.
//
// Both modes walk the event log chronologically with POINT-IN-TIME state
// (./walk + ./pit): every test point is scored with features built only from
// events before it — the same view live serving has when it predicts. (The
// previous evaluator scored past events against today's tables: the target's
// own visit made it look "visited in the last 30 min, 0 h ago", which the
// model had learned to exploit, so its scores were inflated.)
//
// REPLAY: the CURRENT live model ranks candidates at the newest test points.
// It has trained on these events, so it is optimistic — use it for RELATIVE
// before/after comparisons.
//
// BACKTEST: fresh LR (+ MLP when the user has it enabled) trained on switch
// points before a time split; a fresh forest fit on events before the split;
// evaluated on points after it. The honest generalization number.
// Residual approximation: embeddings, the bandit, URL prefixes and page-text
// vectors are their current state (diffuse, documented in doc/ML.md).
//
// recall@pool = fraction of test points whose target was in the candidate
// pool AT ALL — separates "ranking failed" from "candidate generation failed".
//
// Every rate comes with a Wilson 95% interval: with ~250 test points a hit@1
// of 40% is ±6 pts; with the old 60 it was ±12 — too wide to tell a change
// from noise.

import { db } from '../shared/db';
import type { TabEvent } from '../shared/types';
import type { ModelBundle } from './candidate-features';
import { RECOMMEND_FEATURE_NAMES } from './features';
import { OnlineLogReg } from './models/logreg';
import { TinyMLP } from './models/mlp';
import { appendEvalHistory, RECOMMEND_MODEL_VERSION } from './persistence';
import { PointInTimeAggregates } from './pit';
import { liveModels, mlpStatus, scoreOpenCandidates, trainImplicitOpen } from './recommend';
import { trainRecommendForest } from './rf-train';
import { walkEvents } from './walk';

export interface EvalMetrics {
  hit1: number;
  hit3: number;
  hit5: number;
  mrr: number;
}

export type Interval = [number, number];

export interface EvalReport {
  mode: 'replay' | 'backtest';
  evaluated: number;
  skipped: number;
  model: EvalMetrics & { recallAtPool: number };
  baseline: EvalMetrics;
  // Wilson 95% intervals for the model's hit rates.
  ci: { hit1: Interval; hit3: Interval; hit5: Interval };
  // Backtest: which ensemble members were evaluated.
  ensemble: string;
  tookMs: number;
}

const FEATURE_COUNT = RECOMMEND_FEATURE_NAMES.length;
const DEFAULT_SAMPLE = 250;
const MAX_TRAIN_POINTS = 1500;

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

export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n === 0) return [0, 0];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
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
  const sample = Math.max(1, opts.sample ?? DEFAULT_SAMPLE);
  const events: TabEvent[] = await db.events.orderBy('ts').toArray();
  const splitTs = Date.now() - (opts.splitDays ?? 7) * 24 * 60 * 60 * 1000;

  // ── Pass 1 (cheap): pick test points and backtest training points ─────
  const allPoints: TabEvent[] = [];
  await walkEvents(events, null, (e, point) => {
    if (point) allPoints.push(e);
  });
  const testCandidates = mode === 'backtest' ? allPoints.filter((e) => e.ts >= splitTs) : allPoints;
  const testSet = new Set(testCandidates.slice(-sample));
  const trainSet = new Set(
    mode === 'backtest' ? allPoints.filter((e) => e.ts < splitTs).slice(-MAX_TRAIN_POINTS) : [],
  );

  // ── Split-local models (backtest) ─────────────────────────────────────
  let modelOverride: OnlineLogReg | undefined;
  let mlpOverride: TinyMLP | null | undefined;
  let forestOverride: Awaited<ReturnType<typeof trainRecommendForest>>['forest'] | null | undefined;
  let ensemble = 'live';
  if (mode === 'backtest') {
    modelOverride = new OnlineLogReg(FEATURE_COUNT, { lr: 0.01, l2: 1e-4, l1: 1e-5 });
    modelOverride.setPriorRate(0.25);
    const useMlp = (await mlpStatus()).enabled;
    mlpOverride = useMlp ? new TinyMLP(FEATURE_COUNT) : null;
    forestOverride = (await trainRecommendForest({ endTs: splitTs, persist: false })).forest ?? null;
    ensemble = ['lr', forestOverride ? 'forest' : null, useMlp ? 'mlp' : null]
      .filter(Boolean)
      .join('+');
  }

  // ── Pass 2: point-in-time walk — train before the split, score after ──
  const pit = new PointInTimeAggregates(7);
  const live = await liveModels();
  const models: ModelBundle = {
    ...live,
    seq: pit.seq,
    transition: pit.transition,
    hourActivityZ: (h) => pit.hourActivityZ(h),
  };
  const modelAcc = emptyAcc();
  const baseAcc = emptyAcc();
  let evaluated = 0;

  await walkEvents(events, pit, async (e, point) => {
    if (!point) return;
    const src = pit.source(e.ts);
    if (trainSet.has(e)) {
      await trainImplicitOpen(e, {
        focusHistory: point.focusHistory,
        focusedDomain: point.focusedDomain,
        openDomains: point.focusHistory,
        recentlyFocusedDomains: point.recentlyFocused,
        sessionStartTs: point.sessionStartTs,
        modelOverride,
        mlpOverride: mlpOverride ?? undefined,
        source: src,
        models,
      });
      return;
    }
    if (!testSet.has(e)) return;

    const target = e.domain!;
    let ranked;
    try {
      ranked = await scoreOpenCandidates(
        {
          hour: e.hourOfDay ?? new Date(e.ts).getHours(),
          dow: e.dayOfWeek ?? new Date(e.ts).getDay(),
          focusedDomain: point.focusedDomain,
          openDomains: [],
          pinnedDomains: [],
          focusHistory: point.focusHistory,
          sessionStartTs: point.sessionStartTs,
        },
        {
          deterministic: true,
          now: e.ts,
          modelOverride,
          forestOverride,
          mlpOverride,
          source: src,
          models,
          evaluation: true,
        },
      );
    } catch {
      return;
    }
    const idx = ranked.findIndex((c) => c.domain === target);
    record(modelAcc, idx >= 0 ? idx + 1 : Infinity, idx >= 0);

    // Baseline: point-in-time frecency (no ML), same exclusions.
    const freq = (await src.topByFrecency(101)).filter((s) => s.domain !== point.focusedDomain);
    const bIdx = freq.findIndex((s) => s.domain === target);
    record(baseAcc, bIdx >= 0 ? bIdx + 1 : Infinity, bIdx >= 0);
    evaluated += 1;
  });

  const n = Math.max(1, evaluated);
  const report: EvalReport = {
    mode,
    evaluated,
    skipped: allPoints.length - evaluated,
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
    ci: {
      hit1: wilson(modelAcc.hits1, evaluated),
      hit3: wilson(modelAcc.hits3, evaluated),
      hit5: wilson(modelAcc.hits5, evaluated),
    },
    ensemble,
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
