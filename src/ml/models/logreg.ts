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
  // L1 (sparsity) coefficient — applied via proximal soft-thresholding
  // on the standardized weights after each gradient step. Encourages the
  // model to drive irrelevant features to exactly zero, which both reduces
  // noise and surfaces "what mattered" in the debug panel.
  l1: number;
  trainedSamples: number;
  positiveSamples: number;
  // Platt calibration: P_calibrated = sigmoid(calibA * z + calibB), where z
  // is the LR logit. Initial (1, 0) is the identity.
  calibA: number;
  calibB: number;
  calibSamples: number;
  // Adam optimizer state (per-parameter first/second moment estimates +
  // global timestep). Replaces vanilla SGD. Keeps the model stable across
  // changes in feature scale and noisy gradients.
  adamM: number[];
  adamV: number[];
  adamMBias: number;
  adamVBias: number;
  adamT: number;
}

const CALIB_WARMUP = 20;
const CALIB_LR = 0.01;
const ADAM_BETA1 = 0.9;
const ADAM_BETA2 = 0.999;
const ADAM_EPS = 1e-8;

function softThreshold(w: number, alpha: number): number {
  if (w > alpha) return w - alpha;
  if (w < -alpha) return w + alpha;
  return 0;
}

export class OnlineLogReg {
  state: LogRegState;

  constructor(
    featureCount: number,
    opts?: { lr?: number; l2?: number; l1?: number },
  ) {
    this.state = {
      weights: new Array(featureCount).fill(0),
      bias: 0,
      stats: Array.from({ length: featureCount }, () => welfordEmpty()),
      lr: opts?.lr ?? 0.01,
      l2: opts?.l2 ?? 1e-4,
      l1: opts?.l1 ?? 1e-5,
      trainedSamples: 0,
      positiveSamples: 0,
      calibA: 1,
      calibB: 0,
      calibSamples: 0,
      adamM: new Array(featureCount).fill(0),
      adamV: new Array(featureCount).fill(0),
      adamMBias: 0,
      adamVBias: 0,
      adamT: 0,
    };
  }

  static load(raw: LogRegState): OnlineLogReg {
    const n = raw.weights.length;
    const m = new OnlineLogReg(n);
    m.state = {
      ...raw,
      // Backwards-compat: pre-calibration models won't have these fields.
      calibA: raw.calibA ?? 1,
      calibB: raw.calibB ?? 0,
      calibSamples: raw.calibSamples ?? 0,
      // Adam state may be missing on pre-Adam saves; start fresh moments
      // but keep existing weights so the model isn't reset.
      adamM: Array.isArray(raw.adamM) && raw.adamM.length === n
        ? raw.adamM
        : new Array(n).fill(0),
      adamV: Array.isArray(raw.adamV) && raw.adamV.length === n
        ? raw.adamV
        : new Array(n).fill(0),
      adamMBias: raw.adamMBias ?? 0,
      adamVBias: raw.adamVBias ?? 0,
      adamT: raw.adamT ?? 0,
      l1: raw.l1 ?? 1e-5,
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
    const l1 = this.state.l1;

    // Adam step. Replaces vanilla SGD — keeps progress stable when
    // gradients vary in scale (common with our heterogeneous features).
    this.state.adamT += 1;
    const t = this.state.adamT;
    const biasCorr1 = 1 - Math.pow(ADAM_BETA1, t);
    const biasCorr2 = 1 - Math.pow(ADAM_BETA2, t);

    for (let i = 0; i < s.length; i++) {
      // Gradient: d/dw = err * x_std + l2 * w  (L1 is applied as a
      // proximal step after, not added to the gradient).
      const g = err * s[i] + l2 * this.state.weights[i];
      this.state.adamM[i] = ADAM_BETA1 * this.state.adamM[i] + (1 - ADAM_BETA1) * g;
      this.state.adamV[i] =
        ADAM_BETA2 * this.state.adamV[i] + (1 - ADAM_BETA2) * g * g;
      const mHat = this.state.adamM[i] / biasCorr1;
      const vHat = this.state.adamV[i] / biasCorr2;
      const step = (lr * mHat) / (Math.sqrt(vHat) + ADAM_EPS);
      const wTentative = this.state.weights[i] - step;
      // Proximal soft-threshold for L1 — drives small weights to exactly 0.
      this.state.weights[i] = softThreshold(wTentative, lr * l1);
    }

    // Bias gets the same Adam treatment but no L1 (we want a free intercept).
    const gBias = err;
    this.state.adamMBias =
      ADAM_BETA1 * this.state.adamMBias + (1 - ADAM_BETA1) * gBias;
    this.state.adamVBias =
      ADAM_BETA2 * this.state.adamVBias + (1 - ADAM_BETA2) * gBias * gBias;
    const mHatB = this.state.adamMBias / biasCorr1;
    const vHatB = this.state.adamVBias / biasCorr2;
    this.state.bias -= (lr * mHatB) / (Math.sqrt(vHatB) + ADAM_EPS);

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

  // ── Group-wise sampled softmax (Phase 2.1, learning-to-rank) ─────────
  // The product decision is RANKING (pick the right candidate among a
  // plausible pool), but pointwise `update()` optimizes independent binary
  // cross-entropy. This optimizes the ordering directly: given a group of
  // {1 positive + K negatives} that all share a context, softmax over their
  // logits and push the positive's probability up relative to the rest.
  //
  // Gradient of softmax cross-entropy w.r.t. each logit z_i:
  //   ∂L/∂z_pos = softmax_pos − 1     ∂L/∂z_neg = softmax_neg
  // Accumulate the per-feature gradient across the group, then take ONE Adam
  // step (same optimizer state as `update`). The Welford stats and the
  // Platt calibrator are still fed per-sample with binary labels, so the
  // calibrated probability the UI thresholds on stays meaningful while the
  // ranking weights are trained by the softmax objective.
  updateGroup(
    group: Array<{ x: number[]; positive: boolean }>,
    weight = 1,
  ): void {
    if (group.length < 2) {
      // Degenerate group — fall back to pointwise so the sample isn't wasted.
      if (group.length === 1) this.update(group[0].x, group[0].positive ? 1 : 0, weight);
      return;
    }
    const n = group.length;
    const dim = this.state.weights.length;

    // Welford stats from every sample first (matches `update`).
    for (const g of group) {
      for (let i = 0; i < dim; i++) {
        this.state.stats[i] = welfordPush(this.state.stats[i], g.x[i]);
      }
    }

    // Standardize + logits for each member.
    const S: number[][] = [];
    const z: number[] = [];
    for (const g of group) {
      const s = this.standardize(g.x);
      S.push(s);
      let zi = this.state.bias;
      for (let i = 0; i < dim; i++) zi += s[i] * this.state.weights[i];
      z.push(zi);
    }

    // Softmax over the group's logits (numerically stable).
    const maxZ = Math.max(...z);
    let denom = 0;
    const soft = z.map((zi) => {
      const e = Math.exp(zi - maxZ);
      denom += e;
      return e;
    });
    for (let i = 0; i < n; i++) soft[i] /= denom;

    // Accumulate per-feature gradient: Σ_i (∂L/∂z_i) · s_i  + l2 · w
    const lr = this.state.lr;
    const l2 = this.state.l2;
    const l1 = this.state.l1;
    const grad = new Array(dim).fill(0);
    let gradBias = 0;
    for (let i = 0; i < n; i++) {
      const dZ = (soft[i] - (group[i].positive ? 1 : 0)) * weight;
      gradBias += dZ;
      const s = S[i];
      for (let j = 0; j < dim; j++) grad[j] += dZ * s[j];
    }
    for (let j = 0; j < dim; j++) grad[j] += l2 * this.state.weights[j];

    // One Adam step on the accumulated group gradient.
    this.state.adamT += 1;
    const t = this.state.adamT;
    const bc1 = 1 - Math.pow(ADAM_BETA1, t);
    const bc2 = 1 - Math.pow(ADAM_BETA2, t);
    for (let j = 0; j < dim; j++) {
      const gj = grad[j];
      this.state.adamM[j] = ADAM_BETA1 * this.state.adamM[j] + (1 - ADAM_BETA1) * gj;
      this.state.adamV[j] = ADAM_BETA2 * this.state.adamV[j] + (1 - ADAM_BETA2) * gj * gj;
      const mHat = this.state.adamM[j] / bc1;
      const vHat = this.state.adamV[j] / bc2;
      const step = (lr * mHat) / (Math.sqrt(vHat) + ADAM_EPS);
      this.state.weights[j] = softThreshold(this.state.weights[j] - step, lr * l1);
    }
    this.state.adamMBias = ADAM_BETA1 * this.state.adamMBias + (1 - ADAM_BETA1) * gradBias;
    this.state.adamVBias = ADAM_BETA2 * this.state.adamVBias + (1 - ADAM_BETA2) * gradBias * gradBias;
    this.state.bias -= (lr * this.state.adamMBias / bc1) / (Math.sqrt(this.state.adamVBias / bc2) + ADAM_EPS);

    this.state.trainedSamples += group.length;
    this.state.positiveSamples += group.filter((g) => g.positive).length;

    // Keep the Platt calibrator honest: feed each member with its binary
    // label using the POST-step logit, so predict()'s probability still
    // matches the empirical accept rate even though ranking drives weights.
    if (this.state.trainedSamples >= CALIB_WARMUP) {
      for (let i = 0; i < n; i++) {
        const s = S[i];
        let z2 = this.state.bias;
        for (let j = 0; j < dim; j++) z2 += s[j] * this.state.weights[j];
        const calibP = sigmoid(this.state.calibA * z2 + this.state.calibB);
        const calibErr = (calibP - (group[i].positive ? 1 : 0)) * weight;
        this.state.calibA -= CALIB_LR * calibErr * z2;
        this.state.calibB -= CALIB_LR * calibErr;
        this.state.calibSamples += 1;
      }
    }
  }

  // Initial (cold-start) bias toward the empirical positive rate.
  setPriorRate(rate: number): void {
    if (this.state.trainedSamples > 0) return;
    const r = Math.min(Math.max(rate, 1e-3), 1 - 1e-3);
    this.state.bias = Math.log(r / (1 - r));
  }
}
