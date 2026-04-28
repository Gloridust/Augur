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

## 10. What's NOT done

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
