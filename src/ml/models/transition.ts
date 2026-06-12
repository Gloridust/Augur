// Factorized next-domain transition model (Phase 2.3). Per domain it learns
// two 16-dim vectors: u_d (the domain AS CONTEXT — "when I'm here") and v_d
// (the domain AS TARGET — "I go here next"). Score(from→to) =
// sigmoid(u_from · v_to + bias_to). Unlike the sequence-memory COUNTS (which
// need the exact (from,to) pair to have been observed), the factorization
// GENERALIZES: similar contexts get similar u vectors, so a never-seen
// (from→to) still scores sensibly if `from` resembles contexts that lead to
// `to`. Trained online with the same sampled-softmax objective as the LR
// ranking head.
//
// Two uses: (1) a feature `factorizedTransition` for the LR, and (2) a
// candidate generator (top-K v·u for the focused domain) that directly
// improves recall@pool. ~300 domains × 32 floats + biases ≈ 40 KB.

import { sigmoid } from '../math';

const DIM = 16;
const LR = 0.05;
const L2 = 1e-5;
const INIT = 0.1;

export interface TransitionState {
  domains: string[];
  u: number[]; // flattened domains × DIM
  v: number[]; // flattened domains × DIM
  bias: number[]; // per-target bias
  steps: number;
}

function noise(): number {
  return (Math.random() - 0.5) * INIT;
}

export class TransitionModel {
  state: TransitionState;
  private idx: Map<string, number>;

  constructor(state?: TransitionState) {
    this.state = state ?? { domains: [], u: [], v: [], bias: [], steps: 0 };
    this.idx = new Map();
    for (let i = 0; i < this.state.domains.length; i++) {
      this.idx.set(this.state.domains[i], i);
    }
  }

  static load(raw: TransitionState | undefined): TransitionModel {
    if (!raw || !Array.isArray(raw.domains)) return new TransitionModel();
    return new TransitionModel(raw);
  }

  serialize(): TransitionState {
    return this.state;
  }

  private ensure(domain: string): number {
    const hit = this.idx.get(domain);
    if (hit !== undefined) return hit;
    const i = this.state.domains.length;
    this.state.domains.push(domain);
    this.idx.set(domain, i);
    for (let k = 0; k < DIM; k++) {
      this.state.u.push(noise());
      this.state.v.push(noise());
    }
    this.state.bias.push(0);
    return i;
  }

  private dot(uOff: number, vOff: number): number {
    let s = 0;
    for (let k = 0; k < DIM; k++) s += this.state.u[uOff + k] * this.state.v[vOff + k];
    return s;
  }

  // Raw score(from→to) ∈ (0,1). 0.5 (neutral) for unknown domains.
  score(from: string, to: string): number {
    const fi = this.idx.get(from);
    const ti = this.idx.get(to);
    if (fi === undefined || ti === undefined) return 0.5;
    return sigmoid(this.dot(fi * DIM, ti * DIM) + this.state.bias[ti]);
  }

  // One sampled-softmax step: positive `to`, plus `negatives`. Pushes the
  // positive's score up relative to the sampled negatives, updating u_from,
  // the v's, and target biases.
  observe(from: string, to: string, negatives: string[]): void {
    if (!from || !to || from === to) return;
    const fi = this.ensure(from);
    const ti = this.ensure(to);
    const negIdx = negatives
      .filter((d) => d && d !== from && d !== to)
      .map((d) => this.ensure(d));

    const fOff = fi * DIM;
    // Logits for the group {pos + negs}.
    const items = [ti, ...negIdx];
    const logits = items.map((j) => this.dot(fOff, j * DIM) + this.state.bias[j]);
    const maxL = Math.max(...logits);
    let denom = 0;
    const soft = logits.map((l) => {
      const e = Math.exp(l - maxL);
      denom += e;
      return e;
    });
    for (let i = 0; i < soft.length; i++) soft[i] /= denom;

    // Gradients: ∂L/∂logit_i = soft_i − [i==positive]. Accumulate u grad.
    const uGrad = new Array(DIM).fill(0);
    for (let i = 0; i < items.length; i++) {
      const j = items[i];
      const g = soft[i] - (i === 0 ? 1 : 0);
      const vOff = j * DIM;
      for (let k = 0; k < DIM; k++) {
        uGrad[k] += g * this.state.v[vOff + k];
        // v step (uses current u_from).
        this.state.v[vOff + k] -= LR * (g * this.state.u[fOff + k] + L2 * this.state.v[vOff + k]);
      }
      this.state.bias[j] -= LR * g;
    }
    for (let k = 0; k < DIM; k++) {
      this.state.u[fOff + k] -= LR * (uGrad[k] + L2 * this.state.u[fOff + k]);
    }
    this.state.steps += 1;
  }

  // Top-K most likely next domains for a context (candidate generation).
  topNext(from: string, k: number, exclude?: Set<string>): string[] {
    const fi = this.idx.get(from);
    if (fi === undefined) return [];
    const fOff = fi * DIM;
    const scored: Array<{ d: string; s: number }> = [];
    for (let j = 0; j < this.state.domains.length; j++) {
      const d = this.state.domains[j];
      if (d === from || exclude?.has(d)) continue;
      scored.push({ d, s: this.dot(fOff, j * DIM) + this.state.bias[j] });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, k).map((x) => x.d);
  }

  get vocab(): number {
    return this.state.domains.length;
  }
}
