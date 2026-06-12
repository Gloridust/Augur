import { db } from '../shared/db';
import { sigmoid } from './math';

// Final-score calibration (Phase 4.2). The blended LR+RF score is roughly a
// probability (the LR is Platt-calibrated, the forest outputs leaf rates),
// but the blend + the new banditLogit feature can drift it. This learns a
// 2-parameter Platt layer over the blended score against REALIZED outcomes:
// for each `oracle_shown` impression, did the user open the top-ranked
// domain within 5 minutes? Joinable directly from the event log — the
// impression's top score is stored in `meta.scores[0]`, so no recomputation
// is needed.
//
// OracleHint then thresholds on a genuinely calibrated probability. The
// transform is monotonic, so ranking is untouched — only the absolute number
// the threshold compares against is corrected.

const KV_KEY = 'blendCalib:v1';
const OPEN_WINDOW_MS = 5 * 60 * 1000;
const MIN_SAMPLES = 30;

export interface BlendCalibState {
  a: number;
  b: number;
  n: number;
  updatedAt: number;
}

let cache: BlendCalibState | null = null;

function identity(): BlendCalibState {
  return { a: 1, b: 0, n: 0, updatedAt: 0 };
}

export async function loadBlendCalib(): Promise<BlendCalibState> {
  if (cache) return cache;
  const row = await db.kv.get(KV_KEY);
  const raw = row?.value as BlendCalibState | undefined;
  cache = raw && typeof raw.a === 'number' ? raw : identity();
  return cache;
}

function logit(p: number): number {
  const c = Math.min(0.999, Math.max(0.001, p));
  return Math.log(c / (1 - c));
}

// Apply the calibrator to a blended score (synchronous against a loaded
// snapshot). Identity until enough outcomes have been observed.
export function calibrateFrom(state: BlendCalibState, score: number): number {
  if (state.n < MIN_SAMPLES) return score;
  return sigmoid(state.a * logit(score) + state.b);
}

// Retrain from the event log. Scans oracle_shown impressions, labels each by
// whether the top domain was opened within 5 min, and fits (a, b) by a few
// epochs of 1-D logistic regression on (logit(topScore) → label).
export async function trainBlendCalib(now = Date.now()): Promise<{ samples: number }> {
  const events = await db.events.orderBy('ts').toArray();
  const samples: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== 'oracle_shown') continue;
    const meta = e.meta as { scores?: number[] } | undefined;
    const domains = e.domains;
    const topScore = meta?.scores?.[0];
    const topDomain = domains?.[0];
    if (topScore === undefined || !topDomain) continue;
    // Label: opened topDomain within the window after the impression.
    let opened = 0;
    for (let j = i + 1; j < events.length; j++) {
      const f = events[j];
      if (f.ts - e.ts > OPEN_WINDOW_MS) break;
      if ((f.type === 'open' || f.type === 'navigate' || f.type === 'oracle_accepted') && f.domain === topDomain) {
        opened = 1;
        break;
      }
    }
    samples.push({ x: logit(topScore), y: opened });
  }

  if (samples.length < MIN_SAMPLES) {
    return { samples: samples.length };
  }

  // Fit a, b by gradient descent on log-loss.
  let a = 1;
  let b = 0;
  const lr = 0.05;
  for (let epoch = 0; epoch < 200; epoch++) {
    let ga = 0;
    let gb = 0;
    for (const { x, y } of samples) {
      const p = sigmoid(a * x + b);
      const err = p - y;
      ga += err * x;
      gb += err;
    }
    a -= (lr * ga) / samples.length;
    b -= (lr * gb) / samples.length;
  }

  const state: BlendCalibState = { a, b, n: samples.length, updatedAt: now };
  cache = state;
  await db.kv.put({ key: KV_KEY, value: state, updatedAt: now });
  return { samples: samples.length };
}

export function clearBlendCalibCache(): void {
  cache = null;
}
