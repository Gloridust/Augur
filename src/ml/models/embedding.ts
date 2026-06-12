import { sigmoid } from '../math';

// Skip-gram with negative sampling. Hand-rolled, kept small enough to live
// inside a service worker without warming up a tensor backend.
//
// Two embedding spaces (input "word" + output "context") are standard for
// SGNS — using the input space alone for similarity gives much cleaner
// results than tying them, especially with small vocabs.

export interface EmbeddingState {
  dim: number;
  // Vocabulary as parallel arrays so JSON-serialization works without Map juggling.
  domains: string[];
  // Float arrays serialize cleanly through Dexie's structured clone.
  inVectors: number[];
  outVectors: number[];
  trainedSteps: number;
  lr: number;
  negatives: number;
  updatedAt: number;
}

const INIT_NOISE = 0.1;

function randNoise(): number {
  return (Math.random() - 0.5) * INIT_NOISE;
}

export class SkipGramEmbedding {
  state: EmbeddingState;
  private indexCache: Map<string, number>;

  constructor(state?: EmbeddingState, dim = 32) {
    this.state =
      state ??
      ({
        dim,
        domains: [],
        inVectors: [],
        outVectors: [],
        trainedSteps: 0,
        lr: 0.025,
        negatives: 5,
        updatedAt: 0,
      } satisfies EmbeddingState);
    this.indexCache = new Map();
    for (let i = 0; i < this.state.domains.length; i++) {
      this.indexCache.set(this.state.domains[i], i);
    }
  }

  serialize(): EmbeddingState {
    return this.state;
  }

  vocabSize(): number {
    return this.state.domains.length;
  }

  has(domain: string): boolean {
    return this.indexCache.has(domain);
  }

  ensure(domain: string): number {
    const cached = this.indexCache.get(domain);
    if (cached !== undefined) return cached;
    const idx = this.state.domains.length;
    this.state.domains.push(domain);
    this.indexCache.set(domain, idx);
    for (let k = 0; k < this.state.dim; k++) {
      this.state.inVectors.push(randNoise());
      this.state.outVectors.push(randNoise());
    }
    return idx;
  }

  private dot(aArr: number[], aOff: number, bArr: number[], bOff: number): number {
    let s = 0;
    for (let k = 0; k < this.state.dim; k++) s += aArr[aOff + k] * bArr[bOff + k];
    return s;
  }

  // One SGD step on (center, context) with `negatives` random negative samples.
  step(center: string, context: string, weight = 1): void {
    if (center === context) return;
    const ci = this.ensure(center);
    const oi = this.ensure(context);
    const lr = this.state.lr * weight;
    const inV = this.state.inVectors;
    const outV = this.state.outVectors;
    const cOff = ci * this.state.dim;
    const oOff = oi * this.state.dim;
    const dim = this.state.dim;

    // Positive update: gradient of -log sigmoid(u_c · v_o)
    const dotPos = this.dot(inV, cOff, outV, oOff);
    const sigPos = sigmoid(dotPos);
    const gPos = sigPos - 1; // ∂L/∂z
    // Update output ("context") vector first using current input vector,
    // then update input vector using updated output (or original — both fine).
    const inGrad = new Array(dim).fill(0);
    for (let k = 0; k < dim; k++) {
      inGrad[k] += gPos * outV[oOff + k];
      outV[oOff + k] -= lr * gPos * inV[cOff + k];
    }

    // Negative samples
    const N = Math.min(this.state.negatives, this.vocabSize() - 1);
    for (let n = 0; n < N; n++) {
      let neg = (Math.random() * this.vocabSize()) | 0;
      if (neg === ci || neg === oi) {
        neg = (neg + 1) % this.vocabSize();
      }
      const nOff = neg * dim;
      const dotNeg = this.dot(inV, cOff, outV, nOff);
      const sigNeg = sigmoid(dotNeg);
      const gNeg = sigNeg; // ∂L/∂z for negative
      for (let k = 0; k < dim; k++) {
        inGrad[k] += gNeg * outV[nOff + k];
        outV[nOff + k] -= lr * gNeg * inV[cOff + k];
      }
    }

    for (let k = 0; k < dim; k++) {
      inV[cOff + k] -= lr * inGrad[k];
    }
    this.state.trainedSteps += 1;
  }

  // Directed transition affinity: sigmoid(inVec[from] · outVec[to]). Unlike
  // `cosine` (symmetric, input-space only), this reads the SEPARATE in/out
  // vector tables the skip-gram already maintains, so it captures that
  // A→B and B→A have different likelihoods (workflows are directed). Zero
  // new training or storage — the asymmetric signal was always there, just
  // never exposed. Returns 0 for unknown domains.
  directedScore(from: string, to: string): number {
    const fi = this.indexCache.get(from);
    const ti = this.indexCache.get(to);
    if (fi === undefined || ti === undefined) return 0;
    const dot = this.dot(
      this.state.inVectors,
      fi * this.state.dim,
      this.state.outVectors,
      ti * this.state.dim,
    );
    return sigmoid(dot);
  }

  // Raw input-space vector for a domain (or null if unknown). Used to build
  // a session vector (decayed mean of recent focused domains' embeddings)
  // once per scoring call, then `cosineToVector` answers each candidate.
  getVector(domain: string): Float64Array | null {
    const i = this.indexCache.get(domain);
    if (i === undefined) return null;
    const dim = this.state.dim;
    const off = i * dim;
    const out = new Float64Array(dim);
    for (let k = 0; k < dim; k++) out[k] = this.state.inVectors[off + k];
    return out;
  }

  get dim(): number {
    return this.state.dim;
  }

  // Cosine of a domain's input vector against an arbitrary vector (e.g. a
  // session centroid). Returns 0 for unknown domains or degenerate vectors.
  cosineToVector(domain: string, vec: Float64Array | number[]): number {
    const i = this.indexCache.get(domain);
    if (i === undefined) return 0;
    const dim = this.state.dim;
    const off = i * dim;
    const inV = this.state.inVectors;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let k = 0; k < dim; k++) {
      const av = inV[off + k];
      const bv = vec[k] ?? 0;
      dot += av * bv;
      na += av * av;
      nb += bv * bv;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom < 1e-9 ? 0 : dot / denom;
  }

  cosine(a: string, b: string): number {
    const ai = this.indexCache.get(a);
    const bi = this.indexCache.get(b);
    if (ai === undefined || bi === undefined) return 0;
    const dim = this.state.dim;
    const inV = this.state.inVectors;
    const aOff = ai * dim;
    const bOff = bi * dim;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let k = 0; k < dim; k++) {
      const av = inV[aOff + k];
      const bv = inV[bOff + k];
      dot += av * bv;
      na += av * av;
      nb += bv * bv;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    if (denom < 1e-9) return 0;
    return dot / denom;
  }

  meanCosine(target: string, others: string[]): number {
    if (!this.has(target) || others.length === 0) return 0;
    let sum = 0;
    let count = 0;
    for (const o of others) {
      if (o === target) continue;
      if (!this.has(o)) continue;
      sum += this.cosine(target, o);
      count += 1;
    }
    return count === 0 ? 0 : sum / count;
  }

  // Nearest domains to an arbitrary vector (e.g. a session centroid). Used
  // for candidate-pool expansion (Phase 3.4). In-memory full-vocab scan —
  // fine at a few hundred domains, called once per scoring pass.
  nearestToVector(
    vec: Float64Array | number[],
    k: number,
    exclude?: Set<string>,
  ): string[] {
    const out: Array<{ domain: string; sim: number }> = [];
    for (const d of this.state.domains) {
      if (exclude?.has(d)) continue;
      out.push({ domain: d, sim: this.cosineToVector(d, vec) });
    }
    out.sort((a, b) => b.sim - a.sim);
    return out.slice(0, k).map((o) => o.domain);
  }

  topNeighbors(domain: string, k: number): Array<{ domain: string; cosine: number }> {
    if (!this.has(domain)) return [];
    const out: Array<{ domain: string; cosine: number }> = [];
    for (const d of this.state.domains) {
      if (d === domain) continue;
      out.push({ domain: d, cosine: this.cosine(domain, d) });
    }
    out.sort((a, b) => b.cosine - a.cosine);
    return out.slice(0, k);
  }

  markTrained(now: number): void {
    this.state.updatedAt = now;
  }
}
