# ML · 模型与训练

The full machine-learning pipeline: features, training, calibration, bandit, embeddings, and the smart-cleanup feedback loop. · 完整的 ML 管线：特征、训练、校准、bandit、嵌入、一键清理反馈回路。

---

## 1. Two heads, one class

Augur runs **two recommendation heads**, both built on the same `OnlineLogReg` class:

| Head | Predicts | Features | Source |
|---|---|---|---|
| **A** | "Is the user likely to want to OPEN this domain right now?" | 15 | [`recommend.ts`](../src/ml/recommend.ts) |
| **B** | "Is this open tab a candidate for cleanup?" | 26 | [`cleanup.ts`](../src/ml/cleanup.ts) |

Both heads:
- Standardize features via per-feature Welford running stats
- Train via Adam + L1 proximal soft-thresholding + L2 (in the gradient)
- Calibrate output via online Platt scaling after warm-up
- Have a Beta-Bernoulli Thompson-sampling bandit per `(domain, reason)` arm that multiplies the calibrated probability

Head A also drives the Pin row's smart sort (via [`pins.ts`](../src/ml/pins.ts)) and OracleHint (the dynamic-island top-3 capsule). One model → many surfaces; signals from any surface train the same weights.

## 2. Feature pipeline

### Head A — open recommender (15 features)

| Family | Features |
|---|---|
| Frecency | `freqDecay` (Σ exp(−Δt/τ), τ=14d) |
| Engagement | `avgFocusMs` |
| Per-domain temporal | `hourMatch`, `dowMatch` (softmax over the domain's hour-of-day / dow histogram, indexed by the current hour/dow) |
| Cyclic time | `hourSin`, `hourCos`, `dowSin`, `dowCos` (sin/cos of current hour mod 24, dow mod 7) |
| Recency | `recencyHours` since last visit |
| Time-series | `visitVelocity` (last-24h rate / 14-day baseline, capped at 5×), `sessionContext` (1 if visited in last 30min) |
| Co-occurrence | `cooccurrenceWithFocused` (pair counts within 5-min windows, decayed) |
| Embedding | `embedSimToFocused` (cosine in 32-dim skip-gram space) |
| State | `isCurrentlyOpen`, `isPinnedSomewhere` |

### Head B — cleanup recommender (26 features)

Everything from Head A's per-tab-state perspective, plus tab/window context. Full list in [`features.ts`](../src/ml/features.ts):

| Family | Features |
|---|---|
| Tab age + engagement | `tabAgeMs`, `timeSinceFocusMs`, `focusMs`, `focusCount`, `focusRate` |
| Tab flags | `isPinned`, `isGrouped`, `isInNamedGroup`, `isDiscarded` |
| Per-tab activity | `navCount` (in-tab navigations since open) |
| Per-domain | `domainVisitsDecay`, `domainAvgFocusMs`, `sameDomainOpenCount`, `domainCloseQuickRate`, `domainCloseWithoutFocusRate` |
| Per-window | `tabIndex` (0..1, normalized position in window strip), `isInActiveWindow`, `windowSameDomainCount` |
| Embedding | `embedSimToOpen` (mean cosine to currently-engaged open domains) |
| Time | `hour`, `dow`, `hourSin`, `hourCos`, `dowSin`, `dowCos` |
| User state | `isIdle` (system idle / locked) |

**Hard rule (not a feature)**: tabs with `tab.audible === true` are dropped from candidates entirely in [`scoreCleanupCandidates`](../src/ml/cleanup.ts) — never auto-flag a media-playing tab regardless of model score. Pinned tabs, the active tab, and the dashboard tab itself are also pre-filtered.

### Why cyclic time encoding

Raw `hour ∈ [0..23]` makes the LR think hour-23 and hour-0 are 23 units apart. They aren't — they're 1 hour apart. Projecting to `(sin(2πh/24), cos(2πh/24))` puts adjacent hours close in feature space, and the model generalizes across nearby times instead of learning each bin independently. Same trick for day-of-week mod 7.

### Feature names are append-only

[`CLEANUP_FEATURE_NAMES`](../src/ml/features.ts) and [`RECOMMEND_FEATURE_NAMES`](../src/ml/features.ts) are the source of truth for the feature index. **Reordering breaks back-compat** with persisted weights — the loader keys features by index, not by name. New features go at the end. Removing a deprecated feature means setting it to 0 in the builder, not deleting it from the array (or bumping the model KV version, which resets weights).

When the feature count changes, bump the KV key (`model:cleanup:vN` → `vN+1`) in [`persistence.ts`](../src/ml/persistence.ts) so the old saved weights are reset rather than silently mis-mapped to the wrong feature indices.

## 3. OnlineLogReg

[`src/ml/models/logreg.ts`](../src/ml/models/logreg.ts).

### Forward pass

```
standardize(x)[i] = (x[i] - μ[i]) / σ[i]    ← Welford running stats
z = bias + Σ w[i] * standardize(x)[i]
predict(x) = sigmoid(calibA * z + calibB)   ← if calibSamples > 0
           = sigmoid(z)                     ← otherwise (cold)
```

### Update step (Adam + L2 + L1)

```
g[i] = err * standardize(x)[i] + l2 * w[i]            ← gradient (L2 inside)
m[i] ← β1 * m[i] + (1-β1) * g[i]                       ← Adam first moment
v[i] ← β2 * v[i] + (1-β2) * g[i]²                      ← Adam second moment
ŵ[i] = w[i] - lr * (m[i]/biasCorr1) / (√(v[i]/biasCorr2) + ε)
w[i] = softThreshold(ŵ[i], lr * l1)                    ← L1 proximal step
```

Defaults: `lr=0.01`, `β1=0.9`, `β2=0.999`, `ε=1e-8`, `l2=1e-4`, `l1=1e-5`.

The L1 proximal soft-threshold drives small weights to **exactly zero**, giving implicit feature selection. Combined with L2, this is elastic net.

The bias has the same Adam treatment but **no L1** — we want a free intercept.

### Calibration (online Platt)

After 20 warm-up samples (`CALIB_WARMUP`), every update also runs a one-step SGD on `(calibA, calibB)`:

```
calibP = sigmoid(calibA * z + calibB)
calibErr = (calibP - y) * weight
calibA -= 0.01 * calibErr * z
calibB -= 0.01 * calibErr
```

This keeps `predict(x)` returning a real probability, not just a sigmoid score. The threshold constants (`SCORE_THRESHOLD = 0.55` for "show as candidate", `0.6` for auto-select) are tied to actual empirical positive rates because of this.

### Cold-start bias

`setPriorRate(rate)` sets the bias to `log(rate / (1-rate))` so the cold model predicts roughly the empirical positive rate (Head A: 0.25; Head B: 0.15) instead of always 0.5.

## 4. BetaBandit (Thompson sampling)

[`src/ml/models/bandit.ts`](../src/ml/models/bandit.ts).

Per-arm Beta-Bernoulli posterior. Each arm is keyed by `${domain}|${reason}` — same domain can have different reasons (e.g. `github.com|low-engagement` vs `github.com|duplicate-domain`).

```
bandit.sample(armId) → draw from Beta(α, β)        ← Thompson-sampled multiplier
candidate.score = baseScore * (0.5 + banditMul)    ← bandit dampens or boosts
```

Updates:
- `recordImpression(armId)` — counted but no α/β change (used for "is this arm warm?")
- `recordAccept(armId)` — α += weight
- `recordDismiss(armId)` — β += weight
- `recordIgnore(armId, 0.5)` — β += 0.5 (soft negative)

This is what makes "you keep ignoring this kind of suggestion → stop suggesting it" emerge from data without a hand-coded rule. The bandit + the LR work together — LR scores domains, bandit suppresses arms the user has consistently rejected.

## 5. SkipGramEmbedding

[`src/ml/models/embedding.ts`](../src/ml/models/embedding.ts).

32-dimensional skip-gram embeddings for domains. Trained nightly (every 12 h via `embeddingRetrain` alarm) from co-occurrence pairs in [`db.cooccurrence`](../src/shared/db.ts) — pairs of domains opened within 5 minutes of each other.

Used for:
- `embedSimToFocused` (Head A) — cosine between candidate domain and currently focused domain
- `embedSimToOpen` (Head B) — mean cosine between this tab's domain and other engaged open domains
- Nearest-neighbor preview in the model debug panel

Initialization uses the Marsaglia-Tsang gamma sampler for the random vectors. After bootstrap, learning rate decays exponentially with training steps.

## 6. Smart-cleanup feedback loop

This is where the auto-select / coral-glow UX in [`TabWall.tsx`](../src/dashboard/components/TabWall.tsx) closes the loop with the model.

### The loop

1. Dashboard mount (or visibility change) → `runSmartCleanup(false)` fires silently.
2. SW returns all candidates with calibrated probability ≥ 0.55 (the `SCORE_THRESHOLD` in `cleanup.ts`).
3. Dashboard filters again to ≥ 0.60 (`AUTO_SELECT_THRESHOLD` in `TabWall.tsx`) — uncertainty rejection. Predictions in [0.55, 0.60) still surface in the InlineCleanupCard but don't get auto-checked.
4. Auto-checked tabs get a coral box-shadow glow with a 2.4s breathing animation.
5. User can uncheck false positives. The glow stays on — it marks "AI proposed", not "currently selected".
6. User clicks Close (or Clear).
7. `flushSmartCleanupFeedback()` walks the `aiSelected` map:
   - Still selected → `'accepted'` (label 1, weight 1.0)
   - Unchecked → `'dismissed-after-suggestion'` (label 0, **weight 2.0**)

### Why 2× weight on corrections

A user un-checking an AI-flagged tab is the highest-information event we ever see. The model was confident enough to put the tab in the auto-select batch (≥ 0.60 calibrated), and the user explicitly disagreed. That's a much stronger gradient signal than a vague dismiss-from-nowhere.

The weighting lives in [`trainCleanupFeedback`](../src/ml/cleanup.ts):

```ts
const weight =
  action === 'snoozed'                    ? 0.5
  : action === 'dismissed-after-suggestion' ? 2.0
  : 1.0;
```

### Cooldown

After the user clicks Clear, a 30-second `lastDismissTsRef` cooldown prevents the visibility-change auto-rerun from immediately re-selecting the same tabs. Close (which actually removes tabs) does NOT enter cooldown — re-eval after closing is fresh content.

## 7. Implicit training

Beyond explicit user feedback, the SW emits **implicit labels** on tab events:

[`trainImplicitCleanup`](../src/ml/cleanup.ts):
- User closed a tab without focusing it (or focusRate < 0.05 after >1h) → label 1, weight 0.4 ("you should have flagged this for cleanup")
- Tab still open after 7 days with non-trivial focus → label 0, weight 0.4 ("don't flag this")

[`trainImplicitOpen`](../src/ml/recommend.ts):
- Logged on every `open` / `navigate` event — the domain that was actually opened gets a positive sample, similar non-opened candidates get negatives.

The 0.4 weight is intentional — implicit signals are noisier than explicit "Keep" / "Close" clicks, so they shouldn't dominate the gradient.

## 8. Calibration thresholds

| Threshold | Where | Meaning |
|---|---|---|
| `0.55` | [`SCORE_THRESHOLD` in cleanup.ts](../src/ml/cleanup.ts) | "Surface as candidate at all" (InlineCleanupCard, smart-cleanup batch input) |
| `0.60` | `AUTO_SELECT_THRESHOLD` in [TabWall](../src/dashboard/components/TabWall.tsx) | "Auto-check in the smart-cleanup batch" — uncertainty rejection above the candidate floor |
| `0.55` | `CONFIDENCE_THRESHOLD` in [OracleHint](../src/dashboard/components/OracleHint.tsx) | "Top candidate confident enough to even show the dynamic island" |

All three are calibrated probabilities — meaningful in absolute terms, not just rank.

## 9. History bootstrap

[`src/ml/history-bootstrap.ts`](../src/ml/history-bootstrap.ts) seeds `db.events` from the user's existing browser history on first install. Without this, a fresh install would stare at an empty model for days.

- `chrome.history.search()` — last 30 days, up to 5000 URLs
- For top 200 by visit count: `chrome.history.getVisits(url)` to get real per-visit timestamps (capped at 100 visits per URL for boundedness)
- For the long tail: one synthetic event at `lastVisitTime`
- Bulk-insert all into `db.events` with `meta.source = 'history-bootstrap'`
- `rebuildFromEvents()` to repopulate domain stats and co-occurrence

Gated by `chrome.runtime.onInstalled.reason === 'install'` so it never re-runs on update. Re-seedable via Settings → Data → "Seed from browser history" (deletes prior bootstrap-tagged events first to avoid duplicates).

## 10. Three-timescale sequence memory (LSTM-inspired)

The recommend head's biggest historical weakness was **no sequence context**: each candidate was scored independently, so the model couldn't say "user just toggled between Slack and Linear three times — predict one of those next" or "Monday 9am they always open Gmail." Two failure modes:

- **Short-term**: rapid back-and-forth in a hot session — the user's micro-workflow.
- **Long-term**: stable workflow patterns AND daily-rhythm habits.

[`DomainSequenceMemory`](../src/ml/models/markov.ts) addresses both with three count-based predictors at three timescales — analogous to an LSTM's separation of short-term cell state and long-term cell state, but in a tractable form for ~1000–10000 events per user:

| Predictor | What it captures | Decay | Conditioned on |
|---|---|---|---|
| `seqProbShort` | Recent micro-session toggles | exp(−Δt / 30 min), 6 h cutoff | `last_focused_domain` |
| `seqProbLong` | Stable workflow patterns | none — counts accumulate forever | `(last₂, last₁)` (trigram) backing off to `last₁` (bigram) with embedding-smoothed unseen pairs |
| `seqProbTime` | Daily rhythm habits | none | `(hour_of_day, last_focused_domain)` |

All three update on the same `observe(history, next, ts, hour)` call. The LR head sees three separate features (`seqProbShort` / `seqProbLong` / `seqProbTime`) and learns the per-user mixture — chaotic users get high weight on `seqProbShort`, routinized users on `seqProbLong` / `seqProbTime`.

### Why not a transformer

At single-user data scale (~1000–10000 events), a multi-layer transformer would overfit massively and cold-start for weeks. The transformer's key intuition — *attention over similar contexts* — is preserved here via the embedding-smoothed long-term backoff: when the model has never seen `(slack → linear)` directly, it borrows mass from `(slack → jira)` and `(slack → asana)` weighted by skip-gram cosine similarity to `linear`. Same effect (similar contexts get similar predictions), at O(1) updates and zero cold-start.

If the user base eventually generates enough cross-user data to make a real transformer trainable, that's a future migration. Not today's data scale.

### Candidate-pool augmentation

Sequence memory also fixes a deeper bug: the recommend pool was previously **pure frecency** (`getTopDomainsByFrecency(80)`). If the right next-domain wasn't in the user's overall top-80, the scorer never even saw it. Now `recommendOpen` calls `seq.topPredictions(focusHistory, hour, now, 20)` and merges those into the pool — so contextually-likely domains get scored even if their global frecency is mid-tier.

### `trainImplicitOpen` context fix

The pre-fix implementation passed `focusedDomain: undefined, openDomains: []` to every implicit-positive training call, meaning `embedSimToFocused`, `isCurrentlyOpen`, and (now) `seqProb*` were all 0 at training time. The model was effectively learning the marginal feature distribution of opens, not the conditional "given context X, opening Y is good" — predictions collapsed to the prior rate.

The fix: SW passes the real focus history, focused domain, and open domains. Training now also samples 5 random non-opened domains from the frecency pool as **negatives** (label=0, weight=0.2). Without explicit negatives, the LR can only learn "this is positive" and scores converge uselessly to the prior; with them, it learns to discriminate.

## 11. Embedding-cluster task state (cleanup head)

The cleanup head used to score each open tab independently, which couldn't capture "user is currently in dev mode, so the leisure tabs are stale regardless of their per-tab stats." Two new features address that:

- `inActiveCluster` ∈ {0, 1} — tab shares a cluster with the user's most recently focused tab.
- `clusterStaleness` ∈ [0, 1] — `(now - max_focus_in_cluster) / 24h`, clamped.

Clustering happens on the fly in [`scoreCleanupCandidates`](../src/ml/cleanup.ts) via [`clusterByEmbedding`](../src/ml/cluster.ts) — average-linkage agglomerative clustering on skip-gram cosine similarity, threshold 0.35. With 5–25 open tabs the O(n³) cost is sub-millisecond. Tabs whose domains aren't in the embedding vocab fall through with `inActiveCluster = 0` and `clusterStaleness = 0` (no signal).

The "active cluster" is the one whose members have the maximum `lastFocusMs` across the cluster. Per-tab `lastFocusMs` is `focusedAt` if currently focused, else `openedAt + focusMs` as a rough proxy.

## 12. Random Forest as nightly batch ensemble

The OnlineLogReg recommend head is linear after standardization — it can't learn "high `freqDecay` AND low `recencyHours` AND `seqProbLong > 0.3` → likely positive" as a single tree path. A 30-tree Random Forest captures these non-linear feature interactions natively.

[`RandomForest`](../src/ml/models/randomforest.ts) is a CART ensemble with bagging + per-split feature subsampling (sqrt of feature count). Trees: max depth 6, min samples per leaf 4, entropy splits. Trained offline by [`rf-train.ts`](../src/ml/rf-train.ts) on a `forestRetrain` alarm every 8 h.

### Training data construction

Walk `db.events` (last 30 days, capped at 1500 events). For each `'open'` / `'navigate'` event:
1. Maintain a rolling `focusHistory` from the focus events seen in chronological order.
2. The opened domain → positive sample (label = 1) with features computed from current state at that ts.
3. Sample 3 random domains from the frecency pool that were NOT just opened → negative samples (label = 0).
4. `RandomForest.fit(X, y)` → persist to KV `model:recommend:forest:v1`.

If there aren't enough events for stable training (< 20 samples), the trainer skips the save rather than overwrite a previously-good forest with noise.

### Inference

In [`recommendOpen`](../src/ml/recommend.ts), each candidate's feature vector is scored by both the LR head and the forest:

```
baseScore = forestReady
  ? 0.5 * lrScore + 0.5 * forest.predict(x)
  : lrScore   // fallback if forest hasn't been trained yet
```

Equal weight for now. Could be learned per-user later by a calibration pass that weights each model by its empirical accuracy on held-out events.

The forest cache is invalidated after a successful retrain (via `invalidateForestCache()`) so the next inference picks up the new weights without an SW restart.

## 13. Gemini Nano helpers (strictly opt-in, never for ranking)

A small subset of UI surfaces use Chrome's built-in Gemini Nano for **content generation** — never for ranking, scoring, or candidate selection. Currently:

- **Workspace naming**: when the user clicks "Save current as workspace", a wand button next to the name input calls `suggestWorkspaceName(domains)` to propose a 2–4 word workspace name.

These calls go through [`useGeminiHelpers`](../src/dashboard/hooks/useGeminiHelpers.ts) which gates on:
1. **User opt-in** — `localStorage['augur:useGeminiHelpers']` defaults to `'false'`. Toggle in Settings → General → "On-device AI helpers". Off until explicitly enabled.
2. **API availability** — `window.LanguageModel` exists AND `availability()` returns `'available'` or `'downloadable'`. Falls through silently otherwise.
3. **Per-call timeout** — 8s `AbortController`. If the model's slow or hangs, the helper returns `null` and the caller uses its deterministic fallback.

### Why this is gated

- Non-Chrome browsers don't have the Prompt API → falls back automatically.
- Mainland China users may not be able to download the Gemini Nano weights → falls back automatically.
- Privacy-conscious users who don't want to invoke an LLM at all → can leave it off, lose nothing functional.

**The ranking pipeline (LR + RF + bandit + sequence memory + clustering) is 100% deterministic, on-device, and unaffected by the Gemini toggle.** Predictions never depend on Gemini being available.

### Why not use Gemini for ranking

- Inference latency (~100–500ms per call) × 80 candidates = unusable for real-time recommendation.
- LLM logits are not calibrated probabilities.
- Gemini was trained on the public web, not your specific browsing patterns. Personalization is exactly what it can't provide.

## 14. Mixture negative sampling (v7)

Negative-sample distribution history for `trainImplicitOpen` / the forest dataset builder:

| Era | Distribution | Failure mode |
|---|---|---|
| v5 | Top-60 frecency only | Model learned "popular / co-occurring = negative"; `cooccurrenceWithFocused` weight hit −2.0; OracleHint top-1 systematically wrong |
| v6 | Uniform over `db.domains` | Fixed the shortcut, but all negatives are "easy" — random domains share no context features with the positive. Model learns plausible-vs-random, not which-plausible-one |
| **v7** | **3 easy (uniform) + 2 hard (sequence model's own top predictions that the user did NOT open)** | Hard negatives share the positive's context profile (high cooccurrence, high seqProb), so only fine-grained feature interplay separates them — exactly the decision boundary the live ranking needs |

When the sequence memory is too young to supply hard negatives, the easy count tops up to keep total negative weight constant (class balance is preserved at pos 1.0 ≈ neg 5 × 0.2).

## 15. Dwell-time feedback (bandit nudges on close)

An open is only half the signal — what happened next tells us whether it was a *good* open. At tab close, [`nudgeRecommendOnClose`](../src/ml/recommend.ts) routes a dwell verdict into the recommend bandit:

- dwelled ≥ 60s → `recordSoftAccept` (+0.3 α) — the open paid off
- bounced (< 10s focus, never focused) → `recordIgnore` (+0.3 β) — wasted open
- anything between → no update (ambiguous)

This goes through the bandit, not the LR, because LR features describe the *context at open time*, which is gone by close time — but the bandit is per-domain and context-free, so a close-time nudge is well-defined. Soft accepts deliberately don't increment the `acceptances` counter, which stays reserved for explicit user actions.

## 16. Offline replay evaluation

[`evaluateRecommend`](../src/ml/eval.ts) replays the event log chronologically, reconstructs the focus-history context before each historical open, asks the current model to rank candidates for that context (deterministic mode — bandit posterior mean instead of Thompson sampling), and reports **hit@1 / hit@3 / hit@5 / MRR** against a pure-frecency baseline. Surfaced in Settings → Advanced → "Prediction quality".

Honest caveats, also shown in the UI:

- **Replay, not backtest** — the model has already trained on these events, so absolute numbers are optimistic. The value is in the *delta*: run before and after a model change.
- Aggregates (domain stats, embeddings, sequence memory) are at their current state, not as-of each event; time-series features ARE computed as-of each event (the snapshot accepts a historical `now`).
- The baseline comparison answers the question that actually matters: *is the ML stack beating a no-ML frecency sort?* If the Δ column is ever consistently negative, the model is hurting and something is wrong.

## 17. Inference performance

`scoreOpenCandidates` previously cost ~3 IndexedDB range queries per candidate (visit velocity, session context, last-seen URL) × ~100 candidates ≈ 300 queries per new-tab open. [`buildTimeseriesSnapshot`](../src/ml/timeseries.ts) now loads the last 14 days of events **once** and answers all three questions from in-memory maps — 1 bulk query per call, identical semantics (same event-type filters, windows, and caps as the per-domain functions, which remain for low-volume callers like `trainImplicitOpen`).

## 18. The v8 round — ranking objective, directional + session features, decision layer

Model `recommend:v8` bundles Phases 0–4 of [UPGRADE-PLAN.md](UPGRADE-PLAN.md). The structural changes:

**Training distribution (Phase 1).** `trainImplicitOpen` now trains ONLY on switch-events — an opened domain that ≠ the focused one AND wasn't focused in the past 15 min. Same-domain continuation browsing no longer floods the gradient stream; the model is trained on the question it's asked (the evaluator and live recommender both already skip self-transitions). Positives are session-deduped (≤1 per domain per 30 min) and weighted by engagement (forward dwell-join: `clip(log1p(focusMs/30s), 0.5, 2)`) × `openedFrom` intent (direct 1.2 / link 0.8).

**Ranking objective (Phase 2.1).** [`OnlineLogReg.updateGroup`](../src/ml/models/logreg.ts) replaces pointwise binary updates with group-wise sampled softmax: the {positive + 5 mixture negatives} form one group, softmax over their logits, and one Adam step pushes the positive's probability up relative to the rest — directly optimizing the ranking decision the UI makes. The Platt calibrator still runs per-sample (binary labels, post-step logits) so the thresholded probability stays meaningful while ranking drives the weights.

**8 new features (v8).** `transitionAffinity` (directed `sigmoid(inVec[from]·outVec[to])` from the skip-gram's separate in/out tables — A→B ≠ B→A); `sessionSim` + `sessionCohesion` (cosine to a positional-decayed session centroid + how tight the session cluster is — the recommend head's first multi-tab context); `minutesIntoSession` + `isSessionStart` (first-tab vs mid-session intent); `hourActivityZ` (z-score of the hour against the user's OWN rhythm, [`circadian.ts`](../src/ml/circadian.ts)); `banditLogit` (the per-domain acceptance posterior as a learned feature — Phase 4.1, replacing the old multiplicative blend); `prefixConcentration` ([`urlprefix.ts`](../src/ml/urlprefix.ts)).

**Decision layer (Phase 4).** The hard-coded `score × (0.5 + bandit)` is gone — the bandit is a feature both models learn to weight. Live scoring adds small additive exploration jitter that decays with arm impressions. OracleHint gained a margin gate (top1−top2 ≥ 0.08) to kill the "can't separate #1 from #2" false-fire. Predictions surface the domain's top URL **prefix** (`github.com/you/repo`) instead of the bare domain.

**Candidate generation (Phase 3.4).** The pool (frecency top-80) is expanded with sequence-memory top transitions + embedding-NN of the focused domain + embedding-NN of the session centroid, capped at 120. `recall@pool` in the evaluator measures whether the target was even rankable.

**Measurement (Phase 0).** [`eval.ts`](../src/ml/eval.ts) gained `recall@pool`, a persisted eval-history ring (`evalHistory:v1`), and a true backtest mode — train a fresh LR on events older than the split, evaluate on newer ones it never saw. Replay numbers are leakage-optimistic; the backtest number is the honest generalization signal. **No change ships without a backtest delta.**

## 19. Semantic layer, factorized transitions, neural head (v8 extended)

Three more subsystems landed in v8 beyond the Phase 0–4 core:

**Semantic text embeddings (ID → meaning).** The stack historically modeled browsing as a stream of domain IDs — every (A→B) pair learned independently, unfillable at 300 domains. [`textembed.ts`](../src/ml/textembed.ts) embeds each page's title + URL words via the hashing trick (word unigrams + char trigrams → 48-dim signed-hash, L2-normalized — deterministic, no model file, no network). [`domaintext.ts`](../src/ml/domaintext.ts) keeps a running per-domain mean vector. Two features — `titleSimToFocused`, `titleSimToSession` — give the model genuine text similarity: domains never co-visited but whose pages share vocabulary ("invoice", "pull request") now land near each other, which the co-occurrence skip-gram structurally cannot. This is the on-device down-payment on the semantic paradigm; a pretrained sentence model would be better but needs an external asset (see [NEXT-PARADIGM.md](NEXT-PARADIGM.md)).

**Factorized transition model (Phase 2.3).** [`models/transition.ts`](../src/ml/models/transition.ts) learns per-domain u (as-context) and v (as-target) 16-dim vectors; score(from→to) = sigmoid(u_from·v_to + b_to), trained online with sampled softmax. Unlike the sequence-memory COUNTS (which need the exact pair observed), the factorization GENERALIZES across similar contexts. Used as the `factorizedTransition` feature AND a candidate generator (`topNext`), directly improving recall@pool.

**Tiny wide-&-deep MLP (Phase 5, opt-in).** [`models/mlp.ts`](../src/ml/models/mlp.ts) — one tanh hidden layer (16 units), hand-written backprop, same group-softmax objective as the LR, ~600 params. It trains in the background on every group but is **OFF by default**: the live ensemble stays LR+RF until the user enables it (Settings → Advanced toggle) after a backtest confirms it helps. Honors the plan's contingency rule — built and trainable so it's verifiable, dormant until earned.

**Final-score calibration (Phase 4.2 complete).** [`blendcalib.ts`](../src/ml/blendcalib.ts) fits a 2-param Platt layer over the blended ensemble score against realized outcomes (`oracle_shown` → opened-within-5-min, joined from the event log), retrained in the nightly alarm. OracleHint thresholds on a genuinely calibrated probability; the transform is monotonic so ranking is unchanged.

## 20. What's NOT done

Conscious choices to keep the model surface manageable:

- **Multi-task shared bottom** — Head A and Head B share many features but train independently. Sharing a low-dim projection between them could improve sample efficiency 30-50%. Skipped because it requires refactoring both forward passes.
- **Isotonic calibration** — Platt assumes sigmoid-shaped miscalibration. Isotonic relaxes this but needs more samples to be stable. Platt is good enough for now.
- **Per-domain bandit prior from category** — Beta(1,1) cold-start could be replaced with a category-derived prior (social, productivity, media). Needs a domain classifier first.
- **Hash-trick feature crosses** — `domain × hour-of-day` would explicitly model "I always have docs.google.com open Monday 9am" patterns. Currently the model has to learn this implicitly via the cyclic time + per-domain hour softmax features.
- **Sequence features (RNN-lite)** — last-3-domain-focus chain. Useful for "what comes next in the user's workflow" but adds another moving piece.

## See also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — where the SW dispatches the RPC calls that this code answers
- [STORAGE.md](./STORAGE.md) — the KV keys for model weights, bandit state, embeddings
- [API.md](./API.md) — RPC variants for `recommend.*`, `feedback.*`, `model.inspect`, `embedding.retrain`
