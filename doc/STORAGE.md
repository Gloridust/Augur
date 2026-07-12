# Storage · 持久化

Everything Augur stores, where it stores it, and what survives an extension update. · Augur 存储了什么、存哪、更新时哪些保留。

---

## 1. Three layers

| Layer | Lifetime | Cleared by |
|---|---|---|
| `chrome.storage.session` | Browser session | Browser restart |
| `localStorage` (per-extension origin) | Persistent | Manual clear or extension uninstall |
| Dexie / IndexedDB | Persistent across extension updates | Settings → Wipe, or extension uninstall |

**Rule of thumb**: if losing it on browser restart is fine → session. If it's a UI preference → localStorage. If it's training data or model weights → Dexie.

## 2. Dexie schema

Database name: `augur` (legacy: `chromehomepage`). Defined in [`src/shared/db.ts`](../src/shared/db.ts).

### Tables (current version: v4)

| Table | PK | Indexes | Holds |
|---|---|---|---|
| `events` | `++id` | `ts, type, tabId, domain, url, [domain+ts], [type+ts]` | Every observable tab event (open / close / focus / blur / navigate / idle transitions) |
| `feedback` | `++id` | `ts, surface, domain, action` | Explicit user feedback on cleanup / open suggestions |
| `domains` | `domain` | `lastVisit, visitsDecay, updatedAt` | Aggregate stats per domain (visit count, decay-weighted frecency, hour/dow histograms, focus stats) |
| `cooccurrence` | `pair` | `a, b, count, lastSeen` | Pair counts: how often domain A and B were focused within 5 minutes of each other |
| `kv` | `key` | `updatedAt` | Free-form key-value store for model weights, bandit state, embeddings, alarm timestamps |
| `stash` | `++id` | `stashedAt, domain, source, url` | Tabs the user parked in the holding pen |
| `workspaces` | `++id` | `name, updatedAt, createdAt` | Named tab sessions |
| `pins` | `++id` | `&key, pinnedAt, manualOrder` | Pinned shortcuts (drag-reorderable) |

### Schema versions

| Version | Added |
|---|---|
| v1 | `events`, `feedback`, `domains`, `cooccurrence`, `kv` |
| v2 | `stash` |
| v3 | `workspaces` |
| v4 | `pins` |

**No `.upgrade()` callbacks anywhere.** All migrations are purely additive — adding a new table doesn't require migrating existing rows. If a future change needs a destructive migration (e.g. renaming a column), the policy is:

1. Bump the version
2. Define the new schema
3. Add an `.upgrade(tx => …)` callback that maps old rows to new rows
4. Test thoroughly with a populated database before shipping

### What survives an extension update

**All Dexie tables.** Chrome contractually guarantees IndexedDB persistence across extension updates. No data loss when users update from the Chrome Web Store.

Two hardening measures back this up (v0.4.2), closing both known real-world data-loss vectors:

- **Stable `key` in the manifest** (RSA-2048 public key) pins the extension ID independent of the install path. Without it, Chrome derives the ID from the directory, so an unpacked build loaded from a different path opens a *different, empty* IndexedDB — this wiped ~27k events on 2026-07-05. The private key was generated once and discarded.
- **`unlimitedStorage` permission** exempts the extension's IndexedDB (all events + trained model weights) from Chrome's best-effort eviction under disk pressure and lifts the quota cap.

What does NOT survive:
- `chrome.storage.session` keys (browser-restart-scoped, not update-scoped — these survive an update if the browser doesn't restart, but lose on browser quit)
- KV keys orphaned by a bumped model version (see §3 below)

## 3. KV table — model + state

The `kv` table is a free-form key-value store. Keys in use:

| Key | Value | Set by |
|---|---|---|
| `model:cleanup:v3` | Serialized `LogRegState` (weights, bias, Welford stats, Adam moments, Platt calibration) | [`saveCleanupModel`](../src/ml/persistence.ts) |
| `model:recommend:v9` | Same shape, recommendation head (30 features — bumped v8→v9 when `dinAttention` was added) | [`saveRecommendModel`](../src/ml/persistence.ts) |
| `model:recommend:forest:v2` | Serialized RandomForest for the recommend head | [`saveRecommendModel`](../src/ml/persistence.ts) |
| `model:recommend:mlp:v1` | Serialized optional TinyMLP (wide-&-deep head; off by default) | [`saveRecommendModel`](../src/ml/persistence.ts) |
| `bandit:cleanup:v1` | `BanditState` — Map of `armId` → `{ α, β, impressions }` | [`saveBandit('cleanup')`](../src/ml/persistence.ts) |
| `bandit:recommend:v1` | Same shape, recommendation bandit | [`saveBandit('recommend')`](../src/ml/persistence.ts) |
| `embedding:v1` | `EmbeddingState` — vocab + 32-dim vectors + training step count + updatedAt | [`saveEmbedding`](../src/ml/persistence.ts) |
| `transition:v1` | Factorized next-domain transition model (`u`/`v` vectors) | [`persistence.ts`](../src/ml/persistence.ts) |
| `domainText:v1` | Per-domain running mean text-embedding vector | [`persistence.ts`](../src/ml/persistence.ts) |
| `circadian:v1` | Decayed 24-bin personal activity histogram (`hourActivityZ`) | [`persistence.ts`](../src/ml/persistence.ts) |
| `urlPrefixes:v1` | Per-domain decayed 2-segment URL-prefix counts (top 5) | [`persistence.ts`](../src/ml/persistence.ts) |
| `blendCalib:v1` | Platt calibration over the blended LR+RF+MLP score | [`persistence.ts`](../src/ml/persistence.ts) |
| `evalHistory:v1` | Ring (~50) of eval/backtest runs — the lab notebook | [`persistence.ts`](../src/ml/persistence.ts) |
| `mlpEnabled:v1` | Boolean — user toggle that adds the TinyMLP to the ensemble | [`persistence.ts`](../src/ml/persistence.ts) |
| `sequenceMemory:v1` | Three-timescale next-domain sequence counts | [`persistence.ts`](../src/ml/persistence.ts) |
| `errorLog:v1` | Persistent error ring-buffer (last 200 `{ts, context, message, stack}`) | [`errorlog.ts`](../src/shared/errorlog.ts) |
| `lastAggregateAt` | Number — ms timestamp of the last `decayAndPrune` run | [`setLastAggregateAt`](../src/ml/persistence.ts) |
| `lastEmbedTrainAt` | Number — ms timestamp | [`saveEmbedding`](../src/ml/persistence.ts) (side effect) |
| `historyBootstrappedAt` | Number — ms timestamp the one-time history bootstrap completed | [`bootstrapFromHistory`](../src/ml/history-bootstrap.ts) |

### Version bump policy

When a feature-shape change makes existing weights invalid (e.g. adding new features in the middle of `CLEANUP_FEATURE_NAMES` would mis-map old weights), bump the version key:

```ts
// Old
const KV_CLEANUP_MODEL = 'model:cleanup:v2';

// New (after appending new features)
const KV_CLEANUP_MODEL = 'model:cleanup:v3';
```

The loader checks `raw.weights.length === featureCount` and falls through to a fresh model if the length doesn't match. Bumping the key separately ensures even same-length but reordered features get a clean reset.

### Cleaning up old keys

The bumped key leaves the old `model:cleanup:v2` row sitting in `kv` indefinitely. The `chrome.runtime.onInstalled` handler (with `reason === 'update'`) cleans these up:

```ts
// background/index.ts
const STALE_KEYS = ['model:cleanup:v2', 'model:recommend:v2'];
await db.kv.bulkDelete(STALE_KEYS);
```

When you bump a model version, **add the old key to that list**. `bulkDelete` silently ignores missing keys, so the list is monotonic — additions are safe even on fresh installs.

## 4. chrome.storage.session

In-memory across the browser session, shared across all extension contexts (SW, dashboard, popup). Cleared on browser restart.

| Key | Value | Set by | Used by |
|---|---|---|---|
| `tabRuntimeState` | `Record<number, TabRuntimeState>` — per-tab cache of url, openedAt, focusMs, focusCount, navigationCount, etc. | [`background/state.ts`](../src/background/state.ts) | All cleanup-feature builders, focus accounting |
| `focusedTabId` | `number \| undefined` — currently focused tab | [`background/state.ts`](../src/background/state.ts) | Cleanup model, focus segment tracking |
| `idleState` | `chrome.idle.IdleState` — `'active' \| 'idle' \| 'locked'` | [`background/state.ts`](../src/background/state.ts) | `isIdle` cleanup feature; suppresses focus accounting while idle |
| `augur:ai:messages` | `ChatMessage[]` — Augur AI chat history | [`useGeminiChat.ts`](../src/dashboard/hooks/useGeminiChat.ts) | All open dashboard tabs subscribe — cross-tab chat sync |
| `augur:ai:lastActivity` | Number — ms timestamp; drives the 30-min idle clear | [`useGeminiChat.ts`](../src/dashboard/hooks/useGeminiChat.ts) | Each tab schedules its own cleanup setTimeout based on this |
| `augur:ai:stopSignal` | Number — ms timestamp; cross-tab "abort the current stream" signal | [`useGeminiChat.ts`](../src/dashboard/hooks/useGeminiChat.ts) | Owning tab listens and aborts its `AbortController` |

### Why session, not local

These are runtime state caches. Losing them on browser restart is correct behavior — `reconcileOpenTabs()` rebuilds `tabRuntimeState` from currently-open Chrome tabs on `chrome.runtime.onStartup`, and the AI chat is intentionally ephemeral (gemini Nano is on-device anyway).

## 5. localStorage (per-origin)

Persists across browser restarts and extension updates (until manual clear or uninstall). Used for UI prefs that should outlive a session but don't belong in the SW.

| Key | Type | Set by |
|---|---|---|
| `augur:userName` | string | Settings → Profile name input ([`useUserName.ts`](../src/dashboard/hooks/useUserName.ts)) |
| `augur:mode` | `'light' \| 'dark' \| 'system'` | MUI `CssVarsProvider` `modeStorageKey` ([`main.tsx`](../src/dashboard/main.tsx)) |
| `augur:tabWallMode` | `'domain' \| 'window'` | TabWall grouping toggle |
| `augur:onboarded` | string (timestamp) | First-run dialog dismiss |
| `augur:smartPinSort` | boolean | Settings → Pinned row toggle |
| `augur:searchEngine` | `'google' \| 'bing'` | NavSearchBar engine picker |
| `augur:recentSearches` | `string[]` (JSON) | NavSearchBar recent queries |
| `augur:pinDragCooldown` | number (timestamp) | Last manual pin drag — gates smart-sort for 6 h |

Custom events (`augur:user-name-changed` etc.) are dispatched on `window` so any subscribed component re-renders without prop drilling.

## 6. First-install bootstrap

On `chrome.runtime.onInstalled` with `reason === 'install'`, the SW kicks off [`bootstrapFromHistory`](../src/ml/history-bootstrap.ts) async and non-blocking.

- Reads `chrome.history.search({ text: '', startTime: now - 30d, maxResults: 5000 })`
- For top 200 URLs by visit count: `chrome.history.getVisits()` for real timestamps (capped at 100 visits per URL)
- For the long tail: one synthetic event at `lastVisitTime`
- Bulk-insert into `db.events` tagged with `meta.source = 'history-bootstrap'`
- `rebuildFromEvents()` to repopulate `domains` and `cooccurrence`
- Mark `kv['historyBootstrappedAt']` to prevent re-runs

The bootstrap fires only on **install**, never on update. To re-trigger manually: Settings → Data → "Seed from browser history" — the manual path passes `force: true`, which deletes prior bootstrap-tagged events first so re-seeding doesn't accumulate duplicates.

## 7. Wipe

Settings → Data → "Wipe all data" calls [`wipeAllData`](../src/ml/data-ops.ts), which:

1. Clears every Dexie table (`events`, `feedback`, `domains`, `cooccurrence`, `kv`, `stash`, `workspaces`, `pins`)
2. Clears `chrome.storage.session`
3. Removes the `augur:onboarded` localStorage key (so the welcome dialog reappears)
4. Reloads the dashboard

This is destructive and irreversible — the confirmation step is intentional.

A softer "Reset models only" option clears just the model + bandit + embedding KV keys, preserving events and aggregates so retraining can proceed from existing data.

## 8. Export & import

Settings → Data → "Export JSON" calls [`exportAllData`](../src/ml/data-ops.ts) which serializes every Dexie table into one JSON blob and triggers a browser download.

Settings → Data → "Import" now accepts two inputs via [`importAll(raw, { merge })`](../src/ml/data-ops.ts):

- a **`.json`** backup → **full replace** (the whole database is overwritten)
- a debug-bundle **`.zip`** (read by [`zipReader.ts`](../src/dashboard/zipReader.ts)) → **merge**: unions `events` / `feedback` with exact dedupe (idempotent re-import), skips derived tables, keeps local `kv` and only adopts *absent* keys

Either path then runs an automatic warm-up chain: rebuild aggregates → train embeddings → rebuild sequence memory → replay implicit training → retrain forest. Merge mode makes recovery from a shared debug bundle safe and repeatable.

## See also

- [PRIVACY.md](./PRIVACY.md) — what's collected, where it lives, what leaves the browser
- [ML.md](./ML.md) — what's stored under `model:*` and `bandit:*` in detail
- [ARCHITECTURE.md](./ARCHITECTURE.md) — three-layer storage rationale
