import type { SkipGramEmbedding } from './models/embedding';

// Hierarchical agglomerative clustering of domains by skip-gram cosine
// similarity. Used to identify "task clusters" among the user's currently
// open tabs — e.g. dev tabs vs leisure tabs vs research tabs — so the
// cleanup head knows that "user is currently in dev mode" implies the
// leisure tabs are stale regardless of their individual focus stats.
//
// Average-linkage merge with a cosine-similarity floor: clusters keep
// merging as long as the BEST pair across the two has avg pairwise
// cosine ≥ threshold. With ~5–25 open tabs the O(n³) cost is negligible
// (sub-millisecond).

export interface ClusterMember<T = unknown> {
  domain: string;
  payload: T;
}

export interface DomainCluster<T = unknown> {
  members: ClusterMember<T>[];
}

const DEFAULT_SIM_THRESHOLD = 0.35;

function avgPairwiseCosine(
  a: ClusterMember[],
  b: ClusterMember[],
  embedding: SkipGramEmbedding,
): number {
  let total = 0;
  let count = 0;
  for (const x of a) {
    for (const y of b) {
      if (x.domain === y.domain) continue;
      total += embedding.cosine(x.domain, y.domain);
      count += 1;
    }
  }
  return count > 0 ? total / count : 0;
}

export function clusterByEmbedding<T>(
  members: ClusterMember<T>[],
  embedding: SkipGramEmbedding,
  simThreshold: number = DEFAULT_SIM_THRESHOLD,
): DomainCluster<T>[] {
  if (members.length === 0) return [];

  // Start: each member its own singleton cluster
  let clusters: DomainCluster<T>[] = members.map((m) => ({ members: [m] }));

  while (clusters.length > 1) {
    let bestPair: [number, number] | null = null;
    let bestSim = -Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = avgPairwiseCosine(
          clusters[i].members,
          clusters[j].members,
          embedding,
        );
        if (sim > bestSim) {
          bestSim = sim;
          bestPair = [i, j];
        }
      }
    }
    if (!bestPair || bestSim < simThreshold) break;
    const [i, j] = bestPair;
    const merged: DomainCluster<T> = {
      members: [...clusters[i].members, ...clusters[j].members],
    };
    // Remove indices i and j (j > i so remove j first to keep i valid)
    clusters = clusters.filter((_, k) => k !== i && k !== j);
    clusters.push(merged);
  }

  return clusters;
}

// For each member, return the index of the cluster it belongs to.
export function memberToClusterIndex<T>(
  clusters: DomainCluster<T>[],
  predicate: (m: ClusterMember<T>) => boolean,
): number {
  for (let i = 0; i < clusters.length; i++) {
    if (clusters[i].members.some(predicate)) return i;
  }
  return -1;
}
