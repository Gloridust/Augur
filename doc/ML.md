# ML · 模型与训练

The full machine-learning pipeline: features, training, calibration, bandit, embeddings, and the smart-cleanup feedback loop. · 完整的 ML 管线：特征、训练、校准、bandit、嵌入、一键清理反馈回路。

---

## 1. Two heads, one class

Augur runs **two recommendation heads**, both built on the same `OnlineLogReg` class:

| Head | Predicts | Features | Source |
|---|---|---|---|
| **A** | "Is the user likely to want to OPEN this domain right now?" | **30** (`recommend:v11`) | [`recommend.ts`](../src/ml/recommend.ts) |
| **B** | "Is this open tab a candidate for cleanup?" | 26 (`cleanup:v5`) | [`cleanup.ts`](../src/ml/cleanup.ts) |

Both heads:
- Standardize features via per-feature Welford running stats
- Train via Adam + L1 proximal soft-thresholding + L2 (in the gradient)
- Calibrate output via online Platt scaling after warm-up
- Have a Beta-Bernoulli Thompson-sampling bandit per `(domain, reason)` arm. On the cleanup head the bandit still multiplies the score; on the open head it was **promoted to a learned feature** (`banditLogit`) in v8 rather than a hard-coded multiplier.

Head A is no longer a bare LogReg — it's the linear member of an **ensemble** (see §3.1): `LogReg + RandomForest + optional TinyMLP`. Head A also drives the Pin row's smart sort (via [`pins.ts`](../src/ml/pins.ts)) and OracleHint (the dynamic-island top-3 capsule). One model → many surfaces; signals from any surface train the same weights.

> **Reality check (from a real usage trace).** The hit@3 ≈ 85–92% this section used to quote came from an evaluator that leaked the future (§21). Measured point-in-time on the same July 2026 trace, the open head scores **hit@1 ≈ 10%, hit@3 ≈ 23%, MRR 0.18** on held-out switches, against a frecency baseline of 0% / 8% / 0.07 — with a ceiling of 56%, because 44% of the targets were domains the user had never visited before. ~97% of a heavy user's tab-opens also happen through the address bar / link-clicks an extension can't intercept, so the open surfaces see little adoption. The feature with real traction is **cleanup** (§6) — which is why the recent work went there (bulk Declutter sweep + stale-tab badge).

## 2. Feature pipeline

### Head A — open recommender (30 features)

The order in [`RECOMMEND_FEATURE_NAMES`](../src/ml/features.ts) is the source of truth (append-only — see §2.4). Grouped by the version that introduced them:

| Family (version) | Features |
|---|---|
| Frecency (v1) | `freqDecay` (Σ exp(−Δt/τ), τ=14d) |
| Engagement (v1) | `avgFocusMs` |
| Per-domain temporal (v1) | `hourMatch`, `dowMatch` (softmax over the domain's hour-of-day / dow histogram, indexed by the current hour/dow) |
| Recency (v1) | `recencyHours` since last visit |
| Co-occurrence (v1) | `cooccurrenceWithFocused` (pair counts within 5-min windows, decayed) |
| Embedding (v1) | `embedSimToFocused` (cosine in 32-dim skip-gram space) |
| Time-series (v1) | `visitVelocity` (last-24h rate / 14-day baseline, capped at 5×), `sessionContext` (1 if visited in last 30min) |
| State (v1) | `isCurrentlyOpen`, `isPinnedSomewhere` |
| Cyclic time (v3) | `hourSin`, `hourCos`, `dowSin`, `dowCos` (sin/cos of current hour mod 24, dow mod 7) |
| Sequence memory (v4) | `seqProbShort`, `seqProbLong`, `seqProbTime` — three timescales from [`models/markov.ts`](../src/ml/models/markov.ts); the LR learns the per-user mixture (see §6) |
| Directed / session / decision (v8) | `transitionAffinity` (asymmetric A→B from in/out skip-gram tables), `sessionSim` (cosine to the multi-tab session centroid), `sessionCohesion` (session cluster tightness), `minutesIntoSession`, `isSessionStart`, `hourActivityZ` (z-score of the hour vs the user's OWN rhythm), `banditLogit` (acceptance posterior as a logit), `prefixConcentration` (share of traffic in the domain's top URL prefix) |
| Semantic + factorized (v8) | `titleSimToFocused`, `titleSimToSession` (hashed title/URL text vectors — shared vocabulary even for never-co-visited domains), `factorizedTransition` (u(context)·v(target) — fires for (from→to) pairs the count tables never saw) |
| **Target attention (v9)** | **`dinAttention`** — DIN-style candidate-as-query attention over the recent focus history (§3.2) |

### Model inputs are log-scaled where the signal is a ratio

`RecommendFeatures` keeps raw, readable values (reasons, debug UI). [`vectorFromRecommend`](../src/ml/features.ts) — the only path into any model — applies `log1p` to `recencyHours`, `freqDecay`, `avgFocusMs` (in seconds), `cooccurrenceWithFocused` and `minutesIntoSession`. Raw `recencyHours` ran 0 → 720 with a std of hundreds, so after the LR's linear standardization "1 h vs 10 h since the last visit" — the strongest single signal in the data — was a rounding error.

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

Defaults: `lr=0.01`, `β1=0.9`, `β2=0.999`, `ε=1e-8`, `l2=1e-4`, `l1=1e-5`. **Head A uses `lr=0.001`**: Adam moves every weight by ~`lr` per step whatever its gradient, so on a few hundred training groups the ~28 weakly-informative weights random-walked to ±0.5 and drowned the real signal (point-in-time backtest MRR 0.11 at 0.01 vs 0.18 at 0.001).

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

Head A also starts from an informative **weight prior** (`RECOMMEND_WEIGHT_PRIOR`: `recencyHours −1.0`, `freqDecay +0.4` in standardized space — "recent, then frequent"). With little data the learned ranker therefore behaves like that rule instead of like noise, and the data refines it. On the July 2026 trace the untrained prior alone already scores hit@3 22.5% point-in-time; a from-zero LR trained on the same ~100 switches scored 10%.

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
4. Auto-checked tabs get a static coral box-shadow glow (it used to breathe on an infinite animation, which repainted every flagged row every frame).
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

### Bulk Declutter sweep (precision head is too timid for hoarders)

The loop above is tuned for **precision** — the LR only auto-flags the ~5 tabs it's very sure about (real accept rate ≈ 86%). But a heavy tab-hoarder sits on 50–100 open tabs, almost all stale, and a 5-at-a-time surface can't keep up. The **Declutter** dialog ([`DeclutterDialog.tsx`](../src/dashboard/components/DeclutterDialog.tsx), backed by `cleanupSweep()` in [`cleanup.ts`](../src/ml/cleanup.ts)) is a **review-then-close** surface, so it optimizes for **recall** instead: it surfaces everything that trips a simple, explainable staleness rule regardless of the model score, and the user deselects the few keepers.

Rule-based tiers (`classifyTier`, ordered most→least obviously a zombie), which **bypass the conservative 0.55 threshold**:

| Tier | Rule | Default-checked |
|---|---|---|
| `never_opened` | `focusCount === 0` (opened, never viewed) | ✅ |
| `stale_week` | not focused in ≥ 7 days | ✅ |
| `stale_day` | not focused in ≥ 24 h | ✅ |
| `stale` | not focused in ≥ 2 h | — (user opts in) |
| `model` | model-confident but no staleness rule matched | — |

Named tab groups (`isInNamedGroup`) are excluded (deliberate user intent); pinned / active / audible / dashboard tabs stay hard-filtered as before. Accepting a bulk close still trains the head (`'accepted'`), same signal as the inline card.

### Stale-tab toolbar badge

Heavy hoarders live inside their tabs, not on the dashboard, so the one always-visible nudge is a count badge on the extension icon ([`updateStaleBadge`](../src/background/index.ts)). It's computed cheaply from the in-memory tab-state map (no `chrome.tabs.query`, no feature pipeline) using the same staleness rules, updated on the 5-min heartbeat, on tab-close, and on reconcile. Clicking the icon opens the dashboard → Declutter.

## 7. Implicit training

Beyond explicit user feedback, the SW emits **implicit labels** on tab events:

**Cleanup — outcome labels** ([`trainCleanupOutcome`](../src/ml/cleanup.ts)). The old implicit rule labelled a tab "stale" from the same idle-time features the model reads — circular. Labels now come from what the user actually did with a backgrounded tab, once it has been out of sight ≥ 30 min:
- switched back to it from another tab → **0** (it was still wanted);
- closed it while it was in the background, not as part of a window closing → **1**.

The SW trains these live (`startFocusSegment`, the close handler); the replay trainer reconstructs them from the log. On the July 2026 trace: 311 outcomes, only 8 of them "closed" — a hoarder almost never closes background tabs, which is why the rule-based Declutter tiers stay primary.

**Open — switch events** ([`trainImplicitOpen`](../src/ml/recommend.ts)). An open/navigate that lands on a new domain (an *arrival*; same-domain SPA routes are not), isn't the focused domain, wasn't seen in the last 2 min, and isn't already open in another tab — the exact rules the evaluator uses for test points. The live SW trains **before** writing the event, so the features can't see it (§21). One sampled-softmax group per switch: the opened domain against 8 negatives drawn from the serving candidate pool (§14).

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

The fix: SW passes the real focus history, focused domain, and open domains, and training samples explicit **negatives** (see §14 for how that distribution evolved). Without negatives, the LR can only learn "this is positive" and scores converge uselessly to the prior; with them, it learns to discriminate.

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

[`trainRecommendForest`](../src/ml/rf-train.ts) walks the **whole** log with point-in-time state (§21) and takes the switch points of the last 30 days before the newest event (anchored to the data, not the wall clock — after a month away the wall-clock window would be empty):
1. Positive: the opened domain (≤ 1 per domain per 30 min), weighted by forward dwell × `openedFrom` intent.
2. 6 negatives drawn from the candidate pool serving would have ranked at that moment.
3. Features from the shared builder, as of that moment. The newest 600 positives are kept; `RandomForest.fit` → `model:recommend:forest:v4`.

If there aren't enough samples for stable training (< 20 rows), the trainer skips the save rather than overwrite a previously-good forest with noise.

### Inference

In [`recommendOpen`](../src/ml/recommend.ts), each candidate's feature vector is scored by both the LR head and the forest:

```
share     = 0.5 · min(1, forest.trainedSamples / 14 000)    # grows with what it was fit on
baseScore = (1 − share) · lrScore + share · forest.predict(x)
```

The share used to be a fixed 50%. A forest fit on ~200 switches (two weeks) is mostly noise and pulled the prior-anchored LR down (backtest MRR 0.18 → 0.16), so it now earns its half-share by ~2000 switches.

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
| v7 | 3 easy (uniform) + 2 hard (sequence model's own top predictions that the user did NOT open) | The "hard" negatives were exactly the domains the sequence features rank high, so the model learned *a high `seqProbShort` marks a negative* (its weight went negative); the easy ones were random, so it never practised the real choice |
| **v11** | **8 drawn uniformly from the serving candidate pool** ([`candidatePool`](../src/ml/recommend.ts)) | — the model is trained on the decision it is asked to make: the opened domain against the other candidates the pool held at that moment. Serving, live training, replay and the forest share the one pool builder |

On a point-in-time backtest the v11 distribution (with log-scaled inputs, §2) lifted MRR from 0.094 to 0.11 on its own; the prior + learning-rate fix (§3) took it to 0.18.

## 15. Dwell-time feedback (bandit nudges on close)

An open is only half the signal — what happened next tells us whether it was a *good* open. At tab close, [`nudgeRecommendOnClose`](../src/ml/recommend.ts) routes a dwell verdict into the recommend bandit:

- dwelled ≥ 60s → `recordSoftAccept` (+0.3 α) — the open paid off
- bounced (< 10s focus, never focused) → `recordIgnore` (+0.3 β) — wasted open
- anything between → no update (ambiguous)

This goes through the bandit, not the LR, because LR features describe the *context at open time*, which is gone by close time — but the bandit is per-domain and context-free, so a close-time nudge is well-defined. Soft accepts deliberately don't increment the `acceptances` counter, which stays reserved for explicit user actions.

## 16. Offline evaluation

[`evaluateRecommend`](../src/ml/eval.ts) walks the log chronologically with point-in-time state (§21) and, at each switch point, ranks the candidates exactly as serving would (same pool, same exclusions — open and focused domains never rank) in deterministic mode. It reports **hit@1 / hit@3 / hit@5 / MRR / recall@pool** against a point-in-time frecency baseline, each hit rate with a **Wilson 95% interval**, on the newest 250 points (±6 pts at hit@1 ≈ 40%; the old 60-point sample was ±12). Surfaced in Settings → Advanced → Prediction quality.

- **Backtest** — fresh LR (+ MLP if enabled) and forest trained only on switches before the split (7 days before the newest event), bandit empty; scored on the switches after it. The honest generalization number.
- **Replay** — today's trained scorer on the newest points. It has trained on them, so use it for before/after deltas only.
- **Paired test** — on the same points, how many only the model got right vs only the baseline, with an exact McNemar p-value. Two overlapping Wilson intervals can't say whether the model beats frecency; this can. July 2026 trace, 3 seeds × splits of 7 and 10 days: hit@1 model-only 12–13 vs baseline-only 0, hit@3 20–22 vs 2–3, **p ≤ 0.0005** in every run.
- **Breakdown** — per kind of open (`typed` in a new tab — the new-tab-page moment; `link` — new tab from a link; `inTab` — link followed in place) and the count of **novel** targets (never visited before the point: unreachable for any ranker, so `1 − novel/n` is the ceiling).

Real-data check, opt-in and seeded so it repeats: `AUGUR_BACKUP=… npx vitest run tests/real-data.test.ts` imports a backup into a fake database, re-runs the warm-up chain and prints both reports.

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

**Tiny wide-&-deep MLP (Phase 5, opt-in).** [`models/mlp.ts`](../src/ml/models/mlp.ts) — one tanh hidden layer (16 units), hand-written backprop, same group-softmax objective as the LR, ~600 params. It trains in the background on every group but is **OFF by default**: the live ensemble stays LR+RF until the user enables it (Settings → Advanced toggle) after evaluation confirms it helps. Honors the plan's contingency rule — built and trainable so it's verifiable, dormant until earned.

> **Verdict (2026-07-29): keep it OFF — it does not earn its place.** (The numbers below came from the pre-§21 evaluator and are inflated; the conclusion — no gain from the MLP at this data size — is unaffected.) Once the MLP reached readiness (344 trained groups on ~16k events), a **replay** A/B (the *only* mode that exercises the MLP — the backtest trains a fresh LR-only override with `mlp = null`, so it is blind to the neural head) showed no gain: MLP-off `hit@1 43% / hit@3 88% / MRR 65%` vs MLP-on `40% / 85% / 63%` — flat-to-slightly-negative, within the n=60 (±~6%) noise band. Expected: with `hit@3` already at the ~81% predictability ceiling, a 600-param net on a few hundred groups has no headroom. Note the DIN attention feature (`dinAttention`, §20) is a *feature* baked into the LR/forest and stays ON — it is not the MLP and is unaffected by this verdict. To re-test after much more data: since v0.5 the **backtest** includes a split-trained MLP whenever the toggle is on, so run 回测/backtest with the toggle off, then on, and compare the deltas against their 95% intervals.

**Final-score calibration (Phase 4.2 complete).** [`blendcalib.ts`](../src/ml/blendcalib.ts) fits a 2-param Platt layer over the blended ensemble score against realized outcomes (`oracle_shown` → opened-within-5-min, joined from the event log), retrained in the nightly alarm. OracleHint thresholds on a genuinely calibrated probability; the transform is monotonic so ranking is unchanged.

## 20. v9 — DIN-style target attention

[`attention.ts`](../src/ml/attention.ts). The one industry-recommender idea that genuinely transfers to a single-user, on-device setting, borrowed from Alibaba's **Deep Interest Network** (DIN, KDD'18) — the pattern behind Taobao/Douyin-class rankers.

DIN's insight: score a candidate by attending over the user's recent behavior sequence **with the candidate as the query**. History items that resemble the candidate get the attention mass, so the model asks *"does this candidate strongly continue **any** thread of what I've been doing?"* rather than comparing against a blurred average.

The `dinAttention` feature (feature #30) computes, over the last 8 focused domains:

```
attended = Σ_i  softmax_i( cos(h_i, c) / τ ) · ρ^i · cos(h_i, c)
dinAttention = (attended + 1) / 2        # → [0, 1], 0.5 = neutral / OOV
```

with temperature `τ = 0.25` and a recency prior `ρ = 0.85` (each step back in history multiplies attention by ρ). It reuses the existing 32-dim skip-gram embeddings.

**Why it adds signal the existing features miss:**
- `sessionSim` compares the candidate to the session *centroid* — in a multi-task session (docs+GitHub interleaved with Twitter) the centroid is a semantic smoothie that dilutes both threads. Attention keeps the threads separate.
- `embedSimToFocused` only sees the single most-recent domain; the thread from three switches ago is invisible.
- The Markov timescales count *exact* domain transitions; they can't generalize to a semantically-similar-but-new continuation. Attention over embeddings can.

**Deliberately parameter-free** (fixed τ + recency prior, no learned attention MLP): full DIN learns its attention network from millions of users; on one user's thousands of events those parameters would overfit before they helped. As with every other predictor in the stack, the LR / forest / MLP heads learn *how much to trust* this one number — a useless signal self-gates to a ~0 weight, so no separate gating is needed.

Offline validation on a real 7-day event trace (cold 31-domain embedding): P(true-next-domain scores higher than a random distractor) = **0.71** as a standalone signal (0.5 = no signal). That test is too easy — real competitors are the other plausible candidates in the pool, not random domains — so treat it as an upper bound; the honest expectation is a few points of hit@1.

## 21. Point-in-time training and evaluation (v0.5)

The July 2026 audit found that training and evaluation read **today's** tables to describe **past** moments. The positive's own visit made it look "visited in the last 30 min, 0 h ago, velocity up"; the embedding already knew co-visits that happened later; test-period domains reached the candidate pool through it. The model learned to exploit all of it, and the evaluator rewarded it: the replay said hit@3 88%.

Now every consumer builds features through **one builder** ([`candidate-features.ts`](../src/ml/candidate-features.ts)) from an `AggregateSource` ([`sources.ts`](../src/ml/sources.ts)) and a `ModelBundle`:

| Consumer | Aggregates | Learned inputs |
|---|---|---|
| Live serving | live DB, half-open windows `[t − w, t)` | live caches |
| Live training | live DB — the SW trains **before** writing the event | live caches |
| Replay, forest, evaluation | [`PointInTimeAggregates`](../src/ml/pit.ts) | rebuilt by the same replay |

`PointInTimeAggregates` replays the log in order with the SW's own update rules — domain stats and co-occurrence via the shared `AggregateReplayer`, velocity/session windows, sequence memory, factorized transitions, circadian histogram, URL prefixes, page-text vectors (the same pure `applyUrlPrefix` / `applyDomainText` the SW uses) and the skip-gram embedding (one batch per 12 h of event time, like the `embeddingRetrain` alarm). Frecency is exact time decay (`decayAt` anchor, read through `frecencyAt`); co-occurrence decays at read time (`pairCountAt`). [`walk.ts`](../src/ml/walk.ts) is the one definition of a switch point, including the open-tab set reconstructed from the log. `tests/pit-parity.test.ts` asserts that point-in-time aggregates equal the live tables at the same instant and that both sources give identical feature vectors.

What each fix was worth on the July 2026 trace (backtest, 120 held-out switches; frecency baseline hit@1 0%, hit@3 8.3%, MRR 0.070):

| Step | hit@1 | hit@3 | MRR |
|---|---|---|---|
| Old evaluator (leaky, as shown in the app) | ~40% | ~80% | — |
| Point-in-time aggregates, today's embedding/prefixes/text | 12.5% | 20.8% | 0.205 |
| + no future domains in the pool | 6.7% | 11.7% | 0.116 |
| + embedding, prefixes, text rebuilt point-in-time | 3.3% | 10.0% | 0.094 |
| + negatives from the serving pool, log-scaled inputs | 5.3% | 10.3% | 0.108 |
| + recency prior, LR lr 0.001, data-sized forest share | **10.5%** | **22.8%** | **0.180** |

The middle rows are the honest-but-broken state: once nothing leaked, the trained ensemble was *below* a two-feature recency rule (10.8% / 20.8%). The last two rows are the actual model fixes. Ceiling: 56% (44% of the targets were first-ever visits).

## 22. What's NOT done

Conscious choices to keep the model surface manageable:

- **Multi-task shared bottom** — Head A and Head B share many features but train independently. Sharing a low-dim projection between them could improve sample efficiency 30-50%. Skipped because it requires refactoring both forward passes.
- **Isotonic calibration** — Platt assumes sigmoid-shaped miscalibration. Isotonic relaxes this but needs more samples to be stable. Platt is good enough for now.
- **Per-domain bandit prior from category** — Beta(1,1) cold-start could be replaced with a category-derived prior (social, productivity, media). Needs a domain classifier first.
- **Hash-trick feature crosses** — `domain × hour-of-day` would explicitly model "I always have docs.google.com open Monday 9am" patterns. Currently the model has to learn this implicitly via the cyclic time + per-domain hour softmax features.
- **Learned-attention DIN / SASRec transformer** — v9's `dinAttention` is a *parameter-free* attention. A learned attention MLP (true DIN) or a small self-attention sequence model (SASRec) is the natural next step, but on one user's thousands of events it would overfit before it helped, and a hand-written backprop transformer in the SW is a real risk surface. Deferred until the recovered event history is large enough and a v9 backtest baseline exists to justify it. (The parameter-free `seqProbShort/Long/Time` + `dinAttention` already cover most of the "what comes next in the workflow" signal.)

## See also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — where the SW dispatches the RPC calls that this code answers
- [STORAGE.md](./STORAGE.md) — the KV keys for model weights, bandit state, embeddings
- [API.md](./API.md) — RPC variants for `recommend.*`, `feedback.*`, `model.inspect`, `embedding.retrain`
