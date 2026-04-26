// Tiny self-contained numerics used by the on-device models.
// Browser-only: no Node deps, no eval, runs inside service worker.

export function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

let pendingNormal: number | null = null;
export function sampleNormal(): number {
  if (pendingNormal !== null) {
    const v = pendingNormal;
    pendingNormal = null;
    return v;
  }
  let u1 = Math.random();
  const u2 = Math.random();
  if (u1 < 1e-12) u1 = 1e-12;
  const r = Math.sqrt(-2 * Math.log(u1));
  const t = 2 * Math.PI * u2;
  pendingNormal = r * Math.sin(t);
  return r * Math.cos(t);
}

// Marsaglia & Tsang Gamma sampler (shape > 0).
export function sampleGamma(shape: number): number {
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number): number {
  const a = sampleGamma(Math.max(alpha, 1e-3));
  const b = sampleGamma(Math.max(beta, 1e-3));
  return a / (a + b);
}

// Welford's online mean/variance — used for feature standardization.
export interface Welford {
  n: number;
  mean: number;
  m2: number;
}

export function welfordEmpty(): Welford {
  return { n: 0, mean: 0, m2: 0 };
}

export function welfordPush(w: Welford, x: number): Welford {
  const n = w.n + 1;
  const delta = x - w.mean;
  const mean = w.mean + delta / n;
  const m2 = w.m2 + delta * (x - mean);
  return { n, mean, m2 };
}

export function welfordStd(w: Welford): number {
  if (w.n < 2) return 1;
  return Math.sqrt(w.m2 / (w.n - 1)) || 1;
}

export function softmax(values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const sum = exps.reduce((s, v) => s + v, 0) || 1;
  return exps.map((v) => v / sum);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}
