// Tiny wide-&-deep head (Phase 5). One hidden layer (tanh), single logit
// output, trained with the SAME group-wise sampled softmax as the LR. ~600
// params, <10 KB persisted, microsecond inference. It can learn feature
// interactions the RandomForest can't express smoothly and the linear LR
// can't express at all.
//
// CONTINGENT by design: the plan gates it on "backtest hit@3 plateaued."
// So it is OFF by default — the live ensemble stays LR+RF. It trains in the
// background regardless, and a debug toggle lets the user enable it as an
// ensemble member AFTER confirming via backtest that it helps. The LR
// remains the fallback and calibration anchor; the MLP never runs alone.

const HIDDEN = 16;
const LR = 0.01;
const L2 = 1e-5;
const ADAM_B1 = 0.9;
const ADAM_B2 = 0.999;
const ADAM_EPS = 1e-8;

export interface MlpState {
  inDim: number;
  // W1: HIDDEN × inDim (flattened), b1: HIDDEN, W2: HIDDEN, b2: scalar.
  w1: number[];
  b1: number[];
  w2: number[];
  b2: number;
  // Per-feature standardization (shared shape with the LR's Welford-ish
  // running stats; here we keep a simple mean/var via streaming moments).
  mean: number[];
  m2: number[];
  count: number;
  // Adam moments.
  mW1: number[]; vW1: number[];
  mb1: number[]; vb1: number[];
  mW2: number[]; vW2: number[];
  mb2: number; vb2: number;
  t: number;
  trainedGroups: number;
}

function tanh(x: number): number {
  return Math.tanh(x);
}

export class TinyMLP {
  state: MlpState;

  constructor(inDim: number, state?: MlpState) {
    if (state) {
      this.state = state;
      return;
    }
    const w1 = new Array(HIDDEN * inDim);
    for (let i = 0; i < w1.length; i++) w1[i] = (Math.random() - 0.5) * (1 / Math.sqrt(inDim));
    const w2 = new Array(HIDDEN);
    for (let i = 0; i < HIDDEN; i++) w2[i] = (Math.random() - 0.5) * (1 / Math.sqrt(HIDDEN));
    this.state = {
      inDim,
      w1, b1: new Array(HIDDEN).fill(0),
      w2, b2: 0,
      mean: new Array(inDim).fill(0),
      m2: new Array(inDim).fill(0),
      count: 0,
      mW1: new Array(HIDDEN * inDim).fill(0), vW1: new Array(HIDDEN * inDim).fill(0),
      mb1: new Array(HIDDEN).fill(0), vb1: new Array(HIDDEN).fill(0),
      mW2: new Array(HIDDEN).fill(0), vW2: new Array(HIDDEN).fill(0),
      mb2: 0, vb2: 0,
      t: 0,
      trainedGroups: 0,
    };
  }

  static load(raw: MlpState | undefined, inDim: number): TinyMLP {
    if (!raw || raw.inDim !== inDim || !Array.isArray(raw.w1)) return new TinyMLP(inDim);
    return new TinyMLP(inDim, raw);
  }

  serialize(): MlpState {
    return this.state;
  }

  isReady(inDim: number): boolean {
    return this.state.inDim === inDim && this.state.trainedGroups >= 50;
  }

  private std(i: number): number {
    if (this.state.count < 2) return 1;
    return Math.sqrt(this.state.m2[i] / (this.state.count - 1)) || 1;
  }

  private standardize(x: number[]): number[] {
    return x.map((v, i) => (v - this.state.mean[i]) / this.std(i));
  }

  // Forward pass → raw logit + cached activations (for backprop).
  private forward(s: number[]): { z: number; h: number[]; pre: number[] } {
    const { w1, b1, w2, b2, inDim } = this.state;
    const pre = new Array(HIDDEN);
    const h = new Array(HIDDEN);
    for (let j = 0; j < HIDDEN; j++) {
      let a = b1[j];
      const off = j * inDim;
      for (let i = 0; i < inDim; i++) a += w1[off + i] * s[i];
      pre[j] = a;
      h[j] = tanh(a);
    }
    let z = b2;
    for (let j = 0; j < HIDDEN; j++) z += w2[j] * h[j];
    return { z, h, pre };
  }

  // Calibrated-ish probability via sigmoid(logit). Used as an ensemble score.
  predict(x: number[]): number {
    const s = this.standardize(x);
    const { z } = this.forward(s);
    return 1 / (1 + Math.exp(-z));
  }

  // Group-wise sampled softmax over {positive + negatives}. Same objective
  // as OnlineLogReg.updateGroup, with backprop through the hidden layer.
  updateGroup(group: Array<{ x: number[]; positive: boolean }>, weight = 1): void {
    if (group.length < 2) return;
    const { inDim } = this.state;
    // Streaming standardization stats.
    for (const g of group) {
      this.state.count += 1;
      for (let i = 0; i < inDim; i++) {
        const d = g.x[i] - this.state.mean[i];
        this.state.mean[i] += d / this.state.count;
        this.state.m2[i] += d * (g.x[i] - this.state.mean[i]);
      }
    }
    const S = group.map((g) => this.standardize(g.x));
    const fwd = S.map((s) => this.forward(s));
    const logits = fwd.map((f) => f.z);
    const maxL = Math.max(...logits);
    let denom = 0;
    const soft = logits.map((l) => {
      const e = Math.exp(l - maxL);
      denom += e;
      return e;
    });
    for (let i = 0; i < soft.length; i++) soft[i] /= denom;

    // Accumulate parameter gradients across the group.
    const gW1 = new Array(HIDDEN * inDim).fill(0);
    const gb1 = new Array(HIDDEN).fill(0);
    const gW2 = new Array(HIDDEN).fill(0);
    let gb2 = 0;
    for (let i = 0; i < group.length; i++) {
      const dZ = (soft[i] - (group[i].positive ? 1 : 0)) * weight;
      const { h, pre } = fwd[i];
      const s = S[i];
      gb2 += dZ;
      for (let j = 0; j < HIDDEN; j++) {
        gW2[j] += dZ * h[j];
        // Backprop through tanh: dPre = dZ · w2_j · (1 − h_j²).
        const dPre = dZ * this.state.w2[j] * (1 - h[j] * h[j]);
        gb1[j] += dPre;
        const off = j * inDim;
        for (let k = 0; k < inDim; k++) gW1[off + k] += dPre * s[k];
      }
      void pre;
    }

    // Adam update.
    this.state.t += 1;
    const t = this.state.t;
    const bc1 = 1 - Math.pow(ADAM_B1, t);
    const bc2 = 1 - Math.pow(ADAM_B2, t);
    const step = (m: number[], v: number[], g: number[], w: number[]) => {
      for (let i = 0; i < g.length; i++) {
        const gi = g[i] + L2 * w[i];
        m[i] = ADAM_B1 * m[i] + (1 - ADAM_B1) * gi;
        v[i] = ADAM_B2 * v[i] + (1 - ADAM_B2) * gi * gi;
        w[i] -= (LR * (m[i] / bc1)) / (Math.sqrt(v[i] / bc2) + ADAM_EPS);
      }
    };
    step(this.state.mW1, this.state.vW1, gW1, this.state.w1);
    step(this.state.mb1, this.state.vb1, gb1, this.state.b1);
    step(this.state.mW2, this.state.vW2, gW2, this.state.w2);
    this.state.mb2 = ADAM_B1 * this.state.mb2 + (1 - ADAM_B1) * gb2;
    this.state.vb2 = ADAM_B2 * this.state.vb2 + (1 - ADAM_B2) * gb2 * gb2;
    this.state.b2 -= (LR * (this.state.mb2 / bc1)) / (Math.sqrt(this.state.vb2 / bc2) + ADAM_EPS);

    this.state.trainedGroups += 1;
  }
}
