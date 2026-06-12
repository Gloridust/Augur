# ML Upgrade Plan — toward on-device optimal

> Status: **Phases 0–4 IMPLEMENTED** (model `recommend:v8`, shipped together
> per the cross-cutting "one bump" rule). Phase 5 remains contingent and is
> NOT built. What landed:
>
> - **Phase 0**: recall@pool, eval-history lab notebook (`evalHistory:v1`),
>   and true backtest mode — Settings → Advanced → Prediction quality has
>   "Run evaluation" (replay) and "Run backtest" buttons + a history table.
> - **Phase 1**: switch-event training filter, session dedup, engagement ×
>   `openedFrom` sample weighting (live LR via group weight; forest via
>   weighted bootstrap; replay via the forward dwell-join).
> - **Phase 2.1**: group-wise sampled softmax (`OnlineLogReg.updateGroup`).
>   **2.2**: directional `transitionAffinity` from the skip-gram in/out
>   tables. **2.3 NOW BUILT**: factorized transition model
>   ([`models/transition.ts`](../src/ml/models/transition.ts)) — u(context)·
>   v(target) vectors, online sampled-softmax, used both as the
>   `factorizedTransition` feature and a candidate generator.
> - **Phase 3**: sessionSim / sessionCohesion / minutesIntoSession /
>   isSessionStart / hourActivityZ, plus candidate-pool expansion (sequence
>   + embedding-NN of focused domain + embedding-NN of session centroid,
>   capped at 120).
> - **Phase 4.1**: bandit is now a learned `banditLogit` feature (the
>   multiplicative blend is gone), with decaying additive exploration
>   jitter on the live path. **4.2 NOW COMPLETE**: OracleHint margin gate
>   (top1−top2 ≥ 0.08) **AND** full blended-score Platt recalibration
>   ([`blendcalib.ts`](../src/ml/blendcalib.ts)) trained nightly from
>   `oracle_shown`→opened-within-5min joins. **4.3**: URL-prefix surfacing
>   (`urlPrefixes:v1`) + `prefixConcentration`.
> - **Phase 5 NOW BUILT (opt-in)**: tiny wide-&-deep MLP
>   ([`models/mlp.ts`](../src/ml/models/mlp.ts)) — one tanh hidden layer,
>   hand-written backprop, same group-softmax objective. Trains in the
>   background; **off by default**. Settings → Advanced has a toggle that
>   adds it to the ensemble — enable only after a backtest confirms it
>   beats LR+RF (honoring the contingency rule).
> - **Semantic layer (paradigm down-payment)**: hashed text embeddings over
>   tab titles/URLs ([`textembed.ts`](../src/ml/textembed.ts) +
>   [`domaintext.ts`](../src/ml/domaintext.ts)) → `titleSimToFocused` /
>   `titleSimToSession`. The ID→meaning shift, on-device, no model asset.
>   See [NEXT-PARADIGM.md](NEXT-PARADIGM.md) for what remains (L2-full
>   pretrained embeddings, L3 two-tower, L4 hazard, L5 task graph).
>
> **Verification is the user's to run** (the dev environment has no event
> data). Prime directive stands: keep a change iff backtest hit@3 improves,
> or holds while hit@1 / recall@pool / calibration improve. Anything that
> regresses backtest hit@3 gets reverted.
>
> Original spec preserved below for reference.

## Diagnosis — where the current architecture stops being optimal

The stack today: hand-crafted features → online LR (Adam+L1, Platt) ⊕
RandomForest (8h batch) × Beta-bandit multiplier, with three-timescale
sequence counts, skip-gram domain embeddings, and embedding clustering
feeding the feature vector. Within the "linear model over hand-crafted
features" paradigm this is near ceiling. The remaining headroom is
*structural*, in four places:

1. **Train/serve distribution mismatch.** `trainImplicitOpen` emits a
   positive for EVERY open/navigate — including same-domain continuation
   browsing. The product predicts *switches* (new-intent events), and the
   evaluator skips self-transitions, but training data is dominated by
   stay events. The model is trained on a different question than it is
   asked.
2. **Wrong objective.** Product metric is ranking (hit@k); training is
   independent binary cross-entropy. Listwise/sampled-softmax directly
   optimizes the ordering decision the UI actually makes.
3. **No directionality.** `embedSimToFocused` is symmetric cosine; real
   workflows are directed (A→B common, B→A rare). The skip-gram already
   stores separate in/out vector tables — the asymmetric signal exists,
   it's just never read.
4. **Uncalibrated decision layer.** `0.5·LR_calibrated + 0.5·RF_raw`,
   then × (0.5 + banditMean) — the OracleHint threshold gates a quantity
   that is not a probability. The bandit's multiplicative blend is ad hoc
   and context-blind.

Plus two product-level gaps: candidate-pool recall is unmeasured (a
target outside the pool is an automatic miss regardless of model
quality), and everything is domain-granular while user value is
URL-granular ("github.com" is not actionable; "github.com/you/repo" is).

### Explicitly rejected directions (and why)

- **Transformer / GRU sequence model** — at ~16k events × ~300-domain
  vocab, a factorized transition model + session vector captures the
  learnable sequence structure; attention layers add instability and
  opacity, not accuracy. Revisit only if Phase 5's preconditions are met.
- **Cross-user / federated anything** — violates the local-only contract.
- **Search-query modeling** — `search_executed` events exist, but
  query-text features are privacy-hot and sparse. Not worth it.
- **Cleanup survival-analysis reframing** — cleanup head already performs
  excellently per user feedback; don't touch what works.

---

## Phase 0 — Measurement hardening *(prerequisite, ~half day)*

Everything later is judged by these numbers; build the judge first.

**0.1 Pool-recall metric.** In `evaluateRecommend`, additionally report
`recallAtPool` = fraction of test points whose target domain was present
in the scored candidate list at all. Separates "ranking failed" from
"candidate generation failed" — they need different fixes.

**0.2 Eval-history persistence.** Append every eval run to a kv key
(`evalHistory:v1`, capped ring of ~50 entries): timestamp, sample size,
recommend-model version, metrics (model + baseline + recall@pool), and a
free-form `note` argument. Render in the debug panel as a compact table
(newest first). Turns tuning into a measured longitudinal process and
survives across sessions — this is the lab notebook.

**0.3 Backtest mode.** `evaluateRecommend({ mode: 'backtest', splitDays: 7 })`:
clone a FRESH OnlineLogReg (and optionally re-fit a forest), replay-train
it only on events with `ts < now − splitDays`, then evaluate on events
after the split. Aggregates/embeddings/sequence memory remain at current
state (document this approximation honestly in the UI). Slower (run on
demand only), but gives a genuine generalization number instead of the
replay metric's leakage-optimism. Debug panel: a second button "Run
backtest".

*Verification: n/a (this phase IS the verification tooling).*

---

## Phase 1 — Training-distribution fix *(highest ROI, ~1 day)*

**1.1 Switch-event positives.** In `trainImplicitOpen`, only emit a
positive when the opened domain (a) ≠ current focused domain, AND (b) was
not focused within the past 15 minutes. Same filter in `rf-train`'s
dataset builder and `replayImplicitTraining`. This aligns train
distribution with the eval/serve distribution (both already skip
self-transitions). Expected: the single largest hit@k jump of the plan.

**1.2 Session dedup.** At most one positive per (domain, 30-minute
window) — stops heavy single-site sessions from flooding the gradient
stream with correlated samples.

**1.3 Engagement-weighted replay.** Live training can't know dwell at
open time, but REPLAY can see the future. In `replayImplicitTraining` and
`rf-train`, weight each positive by
`clip(log1p(subsequentFocusMs / 30_000), 0.5, 2.0)` — opens the user then
actually engaged with teach more than bounces. (Live path keeps weight
1.0; the periodic forest retrain and any warmup replay get the weighted
version automatically.)

**1.4 `openedFrom` weighting.** Events already record `openedFrom`
(direct / link / search). `direct` opens reflect deliberate intent —
weight ×1.2; `link` opens are page-driven — ×0.8. Small, cheap prior.

Model version bump: **v8** (training-distribution change; auto-warmup
re-fits on update). Bump ONCE for phases 1–3 combined if they ship
together — avoid serial cold restarts.

*Verification: backtest hit@1/hit@3 before vs after; expect double-digit
relative improvement on hit@3.*

---

## Phase 2 — Ranking objective + directional transitions *(~1–2 days)*

**2.1 Group-wise sampled softmax (learning-to-rank).** Restructure the
implicit-training step: for each switch event, build the feature vectors
for {positive + 5 mixture negatives} as one GROUP, compute raw logits
z_i (pre-sigmoid), apply softmax cross-entropy over the group, and take
one Adam step on the group gradient. Mechanically this reuses the
existing standardize/Adam plumbing — only the loss changes
(`∂L/∂z_pos = softmax_pos − 1`, `∂L/∂z_neg = softmax_neg`). Keep the
existing binary+Platt path running in parallel on the same samples purely
to maintain a calibrated probability estimate for thresholding (the
ranking weights and the calibration become separate concerns, which is
correct).

**2.2 Directional transition affinity (free feature).** Add feature
`transitionAffinity = sigmoid(inVec[focusedDomain] · outVec[candidate])`
read from the EXISTING skip-gram tables (they already maintain separate
in/out vectors; only symmetric `cosine()` is exposed today). Add a
`directedScore(from, to)` method to `SkipGramEmbedding`. Zero new
training, zero new storage; captures A→B ≠ B→A.

**2.3 Factorized transition model** *(conditional — skip if 2.2's eval
delta is already strong)*. A dedicated next-domain factorization: per
domain, learn `u_d` (as-context) and `v_d` (as-target), 16-dim. Score =
`u_focused · v_candidate + b_candidate`. Train online on switch events
with sampled-softmax (same negatives as 2.1). Persist as
`transition:v1` (~300 domains × 32 floats ≈ 40 KB). Uses: feature #N+1
for the LR, AND a candidate generator (top-K by score — directly
addresses pool recall). The sequence-memory counts remain as exact-match
evidence; the factorization generalizes across similar domains.

*Verification: backtest hit@1 (2.1 should move it most), recall@pool
(2.3), and check the Platt-calibrated probabilities still match empirical
accept rates (calibration must not regress).*

---

## Phase 3 — Context enrichment *(~1 day)*

**3.1 Session vector.** Time-decayed mean of embeddings of the last K≤8
focused domains (half-life 10 min), recomputed at scoring time from the
focus history the SW already maintains. Features:
- `sessionSim` = cosine(candidate, sessionVector) — intent is often
  spread across several tabs, not just the single focused one. (The
  cleanup head already exploits clustering; the recommend head never got
  any multi-tab context. Clear asymmetry, cheap to fix.)
- `sessionCohesion` = mean pairwise similarity among session domains —
  distinguishes "deep in one workflow" (trust sessionSim hard) from
  "wandering" (fall back to temporal/frecency priors). The LR learns this
  gating via the RF's interactions; pass both raw.

**3.2 Session-position features.** `minutesIntoSession` (capped 120) and
`isSessionStart` (first open after a >30 min event gap). First-tab intent
(mail / news / dashboard ritual) differs systematically from mid-session
continuation intent; currently invisible to the model.

**3.3 Personal-circadian hour normalization.** Maintain one global
activity histogram (24 bins, decayed). Feature `hourActivityZ` = z-score
of current hour against the user's OWN rhythm — "is this MY active time"
rather than wall-clock hour. One kv entry, trivial to maintain in the
heartbeat alarm.

**3.4 Candidate-generator expansion** (driven by Phase 0's recall@pool):
add (a) co-occurrence partners of all session domains (table exists,
currently feature-only), (b) embedding nearest-neighbors of the session
vector, (c) "hour specialists" — domains whose hourMatch peaks now but
whose global frecency is mid-tail. Cap pool at ~120. Measure recall@pool
before/after; expansion stops when recall@pool > 0.9.

*Verification: recall@pool ↑ without hit@3 regression (pool growth adds
distractors — the L2R objective from Phase 2 is what keeps ranking robust
to a bigger pool; this ordering is deliberate).*

---

## Phase 4 — Decision layer *(~1 day)*

**4.1 Bandit as feature, not multiplier.** Remove `× (0.5 + sample)`.
Add feature `banditLogit = clip(ln(α/β), −3, 3)` and let the LR learn its
weight. Keep exploration as small additive jitter on the final score
(ε·N(0,1) with ε decaying in arm impressions) — Thompson-style
exploration preserved, but the exploitation path becomes learned and
context-aware instead of hard-coded.

**4.2 Final-score calibration.** One Platt layer over the blended
LR+RF score, trained online on realized outcomes: "top-ranked suggestion
shown → user opened that domain within 5 min" (joinable from existing
`oracle_shown` / open events). OracleHint then gates on
`P_calibrated(top1) ≥ τ` AND margin `score(top1) − score(top2) ≥ δ` —
both interpretable, both tunable against eval history. The margin gate
kills the "two near-identical candidates, model arbitrarily confident in
one" false-fire mode.

**4.3 URL-prefix surfacing.** Per-domain decayed count table of 2-segment
URL prefixes (top 5 per domain, pruned in the nightly alarm). OracleHint
and Suggestions open the best prefix URL instead of the bare domain
root / last-seen URL. New feature `prefixConcentration` (share of the
domain's traffic in its top prefix) — high concentration means a
domain-level suggestion translates to a precise, actionable URL. This is
the change users FEEL most — predictions land on the right page, not the
right site.

*Verification: backtest metrics stable or ↑; then live: OracleHint
accept-rate over the following week (debug bundle `oracle_accepted` /
`oracle_shown`), expect the manual-dismiss share to drop.*

---

## Phase 5 — Contingent: tiny wide-&-deep head

**Precondition: Phases 1–4 shipped AND backtest hit@3 plateaued across
two consecutive eval-history entries.** Otherwise do not build.

One hidden layer MLP (inputs = all ~22 scalar features + the u·v dot
products; hidden 16 tanh; output 1 logit), trained with the same
group-wise sampled softmax, hand-written backprop (~600 params, <10 KB
persisted, microsecond inference). This is the smallest model that can
learn feature interactions the RF can't express smoothly and the LR can't
express at all. It replaces the LR in the ensemble only if backtest says
so; the LR stays as fallback and calibration anchor.

---

## Cross-cutting rules

- **Versioning:** one bump (v8) for phases 1–3 if shipped together;
  Phase 4's feature additions ride the same bump if within the same
  release, else v9. Update `STALE_KEYS` + auto-warmup key check each time
  (see `persistence.ts` / `background/index.ts` precedent).
- **Performance budget:** every new feature must be O(1) per candidate
  from in-memory structures at scoring time (the timeseries-snapshot
  pattern). No per-candidate IndexedDB queries — that regression class is
  what Phase "batched inference" just eliminated.
- **Storage budget:** all new persisted state ≤ ~100 KB total
  (factorization 40 KB + prefix tables ~20 KB + histograms ~1 KB).
- **Honesty in UI:** backtest mode's aggregate-leakage approximation gets
  a visible caveat string, same as the replay caveat today.
- **Promotion rule per phase:** keep the change iff backtest hit@3
  improves, OR stays flat while hit@1 / recall@pool / calibration
  improves. Anything that regresses backtest hit@3 gets reverted —
  no exceptions, no "it feels better".
