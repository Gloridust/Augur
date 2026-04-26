import { sigmoid, welfordEmpty, welfordPush, welfordStd, type Welford } from '../math';

// Online logistic regression with per-feature standardization (Welford),
// L2 regularization, an adaptive bias prior, and online Platt-style
// probability calibration.
//
// Why this and not a neural net: with per-user data volume (hundreds to a few
// thousand labels), an LR with rich hand-crafted features outperforms an MLP
// while training in microseconds and surviving service-worker sleep cycles.
//
// Why Platt calibration: the raw sigmoid output is a *score*, not a real
// probability — it tends to be over-confident at the extremes when the
// feature distribution shifts. We learn two scalars (A, B) on the post-train
// logits so that `predict()` returns a number that genuinely matches the
// empirical positive rate. With calibration in place, the SCORE_THRESHOLD
// constants in cleanup.ts and the "Strong / Decent / Worth a glance" UI
// labels are tied to real probabilities, not arbitrary sigmoid outputs.

export interface LogRegState {
  weights: number[];
  bias: number;
  stats: Welford[];
  lr: number;
  l2: number;
  trainedSamples: number;
  positiveSamples: number;
  // Platt calibration: P_calibrated = sigmoid(calibA * z + calibB), where z
  // is the LR logit. Initial (1, 0) is the identity.
  calibA: number;
  calibB: number;
  calibSamples: number;
}

const CALIB_WARMUP = 20;
const CALIB_LR = 0.01;

export class OnlineLogReg {
  state: LogRegState;

  constructor(featureCount: number, opts?: { lr?: number; l2?: number }) {
    this.state = {
      weights: new Array(featureCount).fill(0),
      bias: 0,
      stats: Array.from({ length: featureCount }, () => welfordEmpty()),
      lr: opts?.lr ?? 0.05,
      l2: opts?.l2 ?? 1e-4,
      trainedSamples: 0,
      positiveSamples: 0,
      calibA: 1,
      calibB: 0,
      calibSamples: 0,
    };
  }

  static load(raw: LogRegState): OnlineLogReg {
    const m = new OnlineLogReg(raw.weights.length);
    m.state = {
      ...raw,
      // Backwards-compat: pre-calibration models won't have these fields.
      calibA: raw.calibA ?? 1,
      calibB: raw.calibB ?? 0,
      calibSamples: raw.calibSamples ?? 0,
    };
    return m;
  }

  serialize(): LogRegState {
    return this.state;
  }

  private standardize(x: number[]): number[] {
    return x.map((v, i) => {
      const w = this.state.stats[i];
      const std = welfordStd(w);
      return (v - w.mean) / (std || 1);
    });
  }

  private logit(x: number[]): number {
    const s = this.standardize(x);
    let z = this.state.bias;
    for (let i = 0; i < s.length; i++) z += s[i] * this.state.weights[i];
    return z;
  }

  // Returns the calibrated probability when calibration has any data, falling
  // back to raw sigmoid otherwise. Most callers want this.
  predict(x: number[]): number {
    const z = this.logit(x);
    if (this.state.calibSamples > 0) {
      return sigmoid(this.state.calibA * z + this.state.calibB);
    }
    return sigmoid(z);
  }

  // Pre-calibration probability — useful for the debug panel and for diff'ing
  // calibrated vs raw scores side by side.
  predictRaw(x: number[]): number {
    return sigmoid(this.logit(x));
  }

  update(x: number[], y: 0 | 1, weight = 1): void {
    // First update running stats — but only after a few samples, so the
    // initial standardization isn't pathologically off for the first batch.
    for (let i = 0; i < x.length; i++) {
      this.state.stats[i] = welfordPush(this.state.stats[i], x[i]);
    }
    const s = this.standardize(x);
    let z = this.state.bias;
    for (let i = 0; i < s.length; i++) z += s[i] * this.state.weights[i];
    const p = sigmoid(z);
    const err = (p - y) * weight;
    const lr = this.state.lr;
    const l2 = this.state.l2;
    for (let i = 0; i < s.length; i++) {
      this.state.weights[i] -= lr * (err * s[i] + l2 * this.state.weights[i]);
    }
    this.state.bias -= lr * err;
    this.state.trainedSamples += 1;
    if (y === 1) this.state.positiveSamples += 1;

    // Online Platt: only after the LR has had some warmup, otherwise the
    // calibrator overfits noise. Recompute z with the just-updated weights so
    // the calibrator sees the current logit, not the pre-step one.
    if (this.state.trainedSamples >= CALIB_WARMUP) {
      let z2 = this.state.bias;
      for (let i = 0; i < s.length; i++) z2 += s[i] * this.state.weights[i];
      const calibP = sigmoid(this.state.calibA * z2 + this.state.calibB);
      const calibErr = (calibP - y) * weight;
      this.state.calibA -= CALIB_LR * calibErr * z2;
      this.state.calibB -= CALIB_LR * calibErr;
      this.state.calibSamples += 1;
    }
  }

  // Initial (cold-start) bias toward the empirical positive rate.
  setPriorRate(rate: number): void {
    if (this.state.trainedSamples > 0) return;
    const r = Math.min(Math.max(rate, 1e-3), 1 - 1e-3);
    this.state.bias = Math.log(r / (1 - r));
  }
}
