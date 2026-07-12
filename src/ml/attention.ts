// DIN-style target attention over the focus history (v9 feature).
//
// The one industry-recommender idea that genuinely transfers to a
// single-user, on-device setting. Alibaba's Deep Interest Network (DIN,
// KDD'18) — the pattern behind Taobao/Douyin-class rankers — scores a
// candidate by attending over the user's recent behavior sequence WITH THE
// CANDIDATE AS THE QUERY: history items that resemble the candidate get the
// attention mass, so the model asks "does this candidate strongly continue
// ANY thread of what I've been doing?" rather than comparing against a
// blurred average.
//
// Why this adds signal our existing features miss:
//   - sessionSim compares the candidate to the session CENTROID — in a
//     multi-task session (docs+GitHub interleaved with Twitter) the centroid
//     is a semantic smoothie and dilutes both threads.
//   - embedSimToFocused only sees the single most recent domain; the thread
//     you were on three switches ago is invisible.
//   - The Markov timescales (seqProbShort/Long/Time) count exact domain
//     transitions; they can't generalize to a semantically-similar-but-new
//     continuation. Attention over embeddings can.
//
// Deliberately PARAMETER-FREE (fixed temperature + recency prior): full DIN
// learns its attention MLP from millions of users; on one user's thousands
// of events those parameters would overfit before they helped. The LR /
// forest / MLP heads learn how much to trust this signal — the stack's
// standard pattern for absorbing a new predictor (a useless signal gets
// weighted to ~0; no separate gating needed).

import type { SkipGramEmbedding } from './models/embedding';

// Sharpness of the attention softmax. Cosines live in [-1, 1]; τ = 0.25
// spreads exp(sim/τ) across ~e^8 between a perfect match and an
// anti-match — sharp enough that one strongly-matching history item
// dominates a handful of unrelated ones.
const TAU = 0.25;
// Recency prior: each step back in history multiplies attention by ρ.
// ρ = 0.85 halves influence roughly every 4 switches — recent threads
// matter more, but a strong match 6 switches back still speaks.
const RHO = 0.85;
const MAX_HISTORY = 8;

// Attention-weighted similarity of `candidate` to the recent focus history,
// mapped to [0, 1]. Returns 0.5 (neutral) when the candidate or the entire
// history is out-of-vocabulary — the LR standardizes features, so a
// constant neutral beats a fake extreme.
export function dinAttention(
  embedding: SkipGramEmbedding,
  history: string[],
  candidate: string,
): number {
  if (!candidate || history.length === 0) return 0.5;
  const cVec = embedding.getVector(candidate);
  if (!cVec) return 0.5;

  const recent = history.slice(-MAX_HISTORY);
  let wSum = 0;
  let acc = 0;
  for (let i = 0; i < recent.length; i++) {
    const h = recent[recent.length - 1 - i]; // i = 0 → most recent
    if (!h || h === candidate) continue; // self-transitions aren't signal
    const sim = embedding.cosineToVector(h, cVec);
    if (sim === 0) continue; // OOV history item (cosineToVector returns 0)
    const w = Math.exp(sim / TAU) * Math.pow(RHO, i);
    wSum += w;
    acc += w * sim;
  }
  if (wSum === 0) return 0.5;
  const attended = acc / wSum; // [-1, 1]
  return Math.max(0, Math.min(1, (attended + 1) / 2));
}
