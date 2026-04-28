// Random Forest classifier — bagged ensemble of CART decision trees with
// per-split feature subsampling. Used as a NIGHTLY BATCH counterpart to the
// online OnlineLogReg recommend head: LR keeps absorbing live signal between
// retrains; the forest captures the non-linear feature interactions the
// linear model can't (e.g. "high recencyHours AND low freqDecay AND seqProbLong > 0.3
// → likely positive" is a tree path the LR can never express).
//
// Training is offline (called from the nightlyDecay alarm). Inference is
// online — at recommend time we run each candidate's feature vector through
// every tree and average the leaf rates. Final score for the recommender is
// an ensemble: 0.5 × LR_calibrated + 0.5 × RF.
//
// Tree depth and forest size are tuned for the SW context: 30 trees × max
// depth 6 keeps the serialized model under ~80KB and inference under ~5ms
// for 100 candidates.

const N_TREES = 30;
const MAX_DEPTH = 6;
const MIN_SAMPLES = 4;
const SUBSAMPLE_RATIO = 0.7;

export interface TreeNode {
  // Leaf if `featureIdx` is undefined.
  value: number;          // predicted positive rate at this leaf
  count: number;          // sample count routed here (for serialization debug)
  featureIdx?: number;
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
}

export interface ForestState {
  trees: TreeNode[];
  featureCount: number;
  trainedAt: number;
  trainedSamples: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

// Mulberry32 — small, deterministic, fast PRNG. Seed once; subsequent
// calls return uniformly-distributed [0, 1) numbers.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function entropyOfIndices(y: number[], indices: number[]): number {
  const total = indices.length;
  if (total === 0) return 0;
  let pos = 0;
  for (const i of indices) pos += y[i];
  const p = pos / total;
  if (p === 0 || p === 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

interface Split {
  featureIdx: number;
  threshold: number;
  leftIdx: number[];
  rightIdx: number[];
  gain: number;
}

function bestSplit(
  X: number[][],
  y: number[],
  indices: number[],
  featureSubset: number[],
): Split | null {
  if (indices.length < 2 * MIN_SAMPLES) return null;
  const baseE = entropyOfIndices(y, indices);
  let best: Split | null = null;

  for (const fIdx of featureSubset) {
    // Collect unique values for this feature among the active indices.
    const vals = new Set<number>();
    for (const i of indices) vals.add(X[i][fIdx]);
    const sorted = Array.from(vals).sort((a, b) => a - b);
    if (sorted.length < 2) continue;

    for (let v = 0; v < sorted.length - 1; v++) {
      const thr = (sorted[v] + sorted[v + 1]) / 2;
      const left: number[] = [];
      const right: number[] = [];
      for (const i of indices) {
        if (X[i][fIdx] <= thr) left.push(i);
        else right.push(i);
      }
      if (left.length < MIN_SAMPLES || right.length < MIN_SAMPLES) continue;
      const eL = entropyOfIndices(y, left);
      const eR = entropyOfIndices(y, right);
      const total = left.length + right.length;
      const wE = (left.length / total) * eL + (right.length / total) * eR;
      const gain = baseE - wE;
      if (!best || gain > best.gain) {
        best = { featureIdx: fIdx, threshold: thr, leftIdx: left, rightIdx: right, gain };
      }
    }
  }
  return best;
}

function leaf(y: number[], indices: number[]): TreeNode {
  let pos = 0;
  for (const i of indices) pos += y[i];
  const value = indices.length > 0 ? pos / indices.length : 0.5;
  return { value, count: indices.length };
}

function buildTree(
  X: number[][],
  y: number[],
  indices: number[],
  depth: number,
  featureCount: number,
  rng: () => number,
): TreeNode {
  if (depth >= MAX_DEPTH) return leaf(y, indices);
  if (indices.length < 2 * MIN_SAMPLES) return leaf(y, indices);
  const lf = leaf(y, indices);
  if (lf.value === 0 || lf.value === 1) return lf;

  // sqrt(featureCount) feature subset per split — the variance-reduction trick
  const k = Math.max(2, Math.floor(Math.sqrt(featureCount)));
  const all = Array.from({ length: featureCount }, (_, i) => i);
  // Fisher-Yates partial shuffle to pick k features
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (all.length - i));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const featureSubset = all.slice(0, k);

  const split = bestSplit(X, y, indices, featureSubset);
  if (!split || split.gain <= 1e-6) return lf;

  return {
    value: lf.value,
    count: lf.count,
    featureIdx: split.featureIdx,
    threshold: split.threshold,
    left: buildTree(X, y, split.leftIdx, depth + 1, featureCount, rng),
    right: buildTree(X, y, split.rightIdx, depth + 1, featureCount, rng),
  };
}

function predictTree(node: TreeNode, x: number[]): number {
  if (node.left === undefined || node.featureIdx === undefined) return node.value;
  if (x[node.featureIdx] <= (node.threshold ?? 0)) return predictTree(node.left, x);
  return predictTree(node.right!, x);
}

// ── Public API ───────────────────────────────────────────────────────

export class RandomForest {
  state: ForestState;

  constructor(state?: ForestState) {
    this.state = state ?? {
      trees: [],
      featureCount: 0,
      trainedAt: 0,
      trainedSamples: 0,
    };
  }

  static load(raw: ForestState | undefined): RandomForest {
    if (!raw || !Array.isArray(raw.trees)) return new RandomForest();
    return new RandomForest(raw);
  }

  serialize(): ForestState {
    return this.state;
  }

  isReady(featureCount: number): boolean {
    return (
      this.state.trees.length > 0 && this.state.featureCount === featureCount
    );
  }

  predict(x: number[]): number {
    if (this.state.trees.length === 0) return 0.5;
    let sum = 0;
    for (const tree of this.state.trees) sum += predictTree(tree, x);
    return sum / this.state.trees.length;
  }

  static fit(
    X: number[][],
    y: number[],
    opts: { seed?: number } = {},
  ): RandomForest {
    if (X.length === 0 || X[0].length === 0) return new RandomForest();
    const featureCount = X[0].length;
    const rng = makeRng(opts.seed ?? 42);
    const trees: TreeNode[] = [];

    for (let t = 0; t < N_TREES; t++) {
      // Bagging: sample with replacement, ratio of original size.
      const sampleSize = Math.max(
        MIN_SAMPLES * 4,
        Math.floor(X.length * SUBSAMPLE_RATIO),
      );
      const indices: number[] = [];
      for (let i = 0; i < sampleSize; i++) {
        indices.push(Math.floor(rng() * X.length));
      }
      trees.push(buildTree(X, y, indices, 0, featureCount, rng));
    }

    return new RandomForest({
      trees,
      featureCount,
      trainedAt: Date.now(),
      trainedSamples: X.length,
    });
  }
}
