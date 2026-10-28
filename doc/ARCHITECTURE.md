# Architecture · 架构

How the pieces fit together: service worker, dashboard, ML, RPC. · 各部分如何串起来：SW、dashboard、ML、RPC。

---

## 1. Three boundaries

```
src/
├── ml/             ← pure model logic, IndexedDB reads/writes
├── background/     ← service worker, chrome.* event listeners, RPC dispatch
└── dashboard/      ← React UI, talks to background only via typed RPC
```

The boundaries are strict:

- **`ml/`** has no `chrome.*` API access except through `background/state.ts` (the runtime-state cache). It's pure functions + Dexie. This makes the ML code testable without a Chrome extension context.
- **`background/`** owns every `chrome.tabs.*`, `chrome.windows.*`, `chrome.idle.*`, `chrome.alarms.*`, `chrome.history.*` listener. It funnels their data into `ml/` and serves dashboard RPC requests.
- **`dashboard/`** never imports from `background/`. It talks to the SW only via `chrome.runtime.sendMessage` wrapped in [`callRpc`](../src/shared/rpc.ts).

This 3-way split means:
- The dashboard renders even if the SW is asleep (it wakes on the first message).
- Adding a new ML feature only touches `ml/` + a small wire-up in `background/`.
- UI redesign doesn't risk corrupting model state.

## 2. Service worker lifecycle

Chrome MV3 service workers are **event-driven** — they sleep after ~30 seconds of inactivity and wake on:
- An incoming message (`chrome.runtime.onMessage`)
- A tab event (`onCreated`, `onUpdated`, `onRemoved`, `onActivated`)
- An alarm tick
- A storage change for tracked keys

**All listener registrations must be at module top-level.** If you register inside an `async function` or after an `await`, the listener won't survive a sleep cycle. See [`background/index.ts`](../src/background/index.ts) — every `chrome.*.addListener(...)` call is at the file's top scope.

**Tracking listeners run one at a time.** Chrome fires listeners concurrently, and async handlers interleave at every `await` — before v0.5.0 two `onUpdated` calls for one navigation both read "previous URL = old" and both logged it (22% duplicate navigates on a real trace), and focus segments raced each other. Every tracking listener now goes through [`enqueue`](../src/background/queue.ts), a promise chain that runs handlers serially and logs (never propagates) a failure. Within one event, [`logEvent`](../src/background/index.ts) trains the open head **before** writing the event, so training features can't see the event they learn from, then writes it and updates aggregates.

**State lives in memory, persisted in batches.** Tab runtime state ([`state.ts`](../src/background/state.ts)) is an in-memory map written to `chrome.storage.session` 1 s after the last change; model state is written to `kv` 5 s after the last change ([`flush.ts`](../src/ml/flush.ts)). The heartbeat flushes both, so a killed SW loses at most a few seconds.

Three persistent timers are scheduled in `chrome.runtime.onInstalled`:

| Alarm | Period | Purpose |
|---|---|---|
| `heartbeat` | 5 min | Stale badge + flush pending state and model writes |
| `nightlyDecay` | 6 h | Normalize decayed frecency; prune cold domains and pairs; prune prefix/text tables |
| `embeddingRetrain` | 12 h | One SkipGramEmbedding batch from co-occurrence pairs |
| `forestRetrain` | 8 h | Refit the recommend forest on point-in-time features |

## 3. Newtab interception

Augur **does not register a `chrome_url_overrides.newtab`**. Instead, the SW intercepts `chrome.tabs.onCreated` for any tab opened to `chrome://newtab/` and rewrites the URL to the dashboard via `chrome.tabs.update`. This dodges Chrome's "Customize Chrome" footer (which is permanently attached to override pages) at the cost of one fundamental limitation: **the omnibox keeps keyboard focus on ⌘T** because Chrome's anti-focus-stealing policy holds focus for tabs we don't own as the newtab.

See [`background/index.ts`](../src/background/index.ts) (the `chrome.tabs.onCreated` and `onUpdated` listeners that rewrite `chrome://newtab/` → `chrome-extension://<id>/src/dashboard/index.html`).

The full rationale and tradeoff lives in the [README "Heads-up" callout](../README.md#quick-start--快速开始).

## 4. RPC contract

Single shared file: [`src/shared/rpc.ts`](../src/shared/rpc.ts).

```ts
export type RpcRequest =
  | { kind: 'recommend.open' }
  | { kind: 'recommend.cleanup' }
  | { kind: 'recommend.cleanup.all'; limit?: number }
  | { kind: 'feedback.cleanup'; domain: string; reason: string; ... }
  | ...;

export type RpcResponse =
  | { ok: true; kind: 'recommend.open'; data: OpenCandidate[] }
  | { ok: true; kind: 'recommend.cleanup'; data: CleanupCandidate[] }
  | ...
  | { ok: true; kind: 'ack' }
  | { ok: false; error: string };
```

Both are **discriminated unions keyed by `kind`**. The `callRpc<R>()` helper wraps `chrome.runtime.sendMessage` and rejects on `chrome.runtime.lastError` or `ok === false`. Dashboard call sites then do:

```ts
const r = await callRpc({ kind: 'recommend.open' });
return r.ok && r.kind === 'recommend.open' ? r.data : [];
```

The `r.kind` check is **necessary** for type narrowing — without it `r.data` is the union of all response data types.

Server-side dispatch is a single switch statement in [`src/background/messaging.ts`](../src/background/messaging.ts).

The full reference is in [API.md](./API.md).

## 5. Storage layers

Three layers, each for a different lifetime:

| Layer | Lifetime | What lives here |
|---|---|---|
| `chrome.storage.session` | Browser session | `TabRuntimeState` map, focused tab id, idle state, Augur AI chat messages |
| `localStorage` (per-origin) | Persistent, per-extension | User name, theme mode, tab-wall mode, onboarding flag, recent searches |
| Dexie / IndexedDB | Persistent across updates | Events, feedback, domains, cooccurrence, stash, workspaces, pins, kv |

**Rule of thumb**: if losing it on browser restart is fine → session. If it's a UI preference → localStorage. If it's training data or model weights → Dexie.

The full schema lives in [STORAGE.md](./STORAGE.md).

## 6. Cross-tab synchronization

Some surfaces in the dashboard need to share state across multiple newtab pages open at the same time. The pattern:

1. Source of truth in `chrome.storage.session`.
2. Each tab's hook hydrates from storage on mount.
3. Each tab subscribes to `chrome.storage.onChanged` and updates local state on changes from other tabs.
4. Mutations always write to storage (which fires the change event back to all tabs, including the originator — fine, dedupe via key equality).

Example: [`useGeminiChat.ts`](../src/dashboard/hooks/useGeminiChat.ts) — Augur AI chat history is shared. Two open dashboard tabs see the same conversation, and the streaming text appears in both as the writing tab flushes chunks every 250 ms.

### Background dashboards do no work

The dashboard is the new-tab page, so a heavy tab user keeps many copies of it in background tabs. [`liveRefresh.ts`](../src/dashboard/liveRefresh.ts) is the one way a surface subscribes to tab activity or polls: events are debounced, `onUpdated` only counts when a shown property changed (url, title, favicon, pinned, discarded, group), and a hidden page records that it is stale and refreshes once when it becomes visible. Suggestions and OracleHint share one `recommend.open` round-trip; OracleHint waits until the page is visible before showing (and logging an impression).

## 7. Build pipeline

[Vite](https://vitejs.dev/) + [`@crxjs/vite-plugin`](https://crxjs.dev/) for MV3 packaging.

```
npm run dev          ← vite + hot-reload (SW changes need a manual reload)
npm run typecheck    ← tsc -b --noEmit
npm run icons        ← regenerate PNGs from public/icons/icon.svg
npm run build        ← tsc + vite build
npm run package      ← build + scripts/package.mjs (zip)
```

[`scripts/generate-icons.mjs`](../scripts/generate-icons.mjs) runs as `prebuild` (and `predev`) — renders 16/32/48/128 PNG icons from `public/icons/icon.svg` via `@resvg/resvg-js`. Single source of truth: edit the SVG, PNGs regenerate.

[`scripts/package.mjs`](../scripts/package.mjs) does the final zip. Notably it **strips `dist/demo/`** before zipping — `public/demo/` holds README screenshots that get copied into `dist/` by Vite's default publicDir behavior, but they shouldn't bloat the extension bundle (saved 2.8 MB in one earlier release).

## 8. Folder structure

```
src/
├── manifest.ts                       # @crxjs reads this
├── shared/
│   ├── db.ts                         # Dexie schema + extractDomain()
│   ├── types.ts                      # cross-boundary types
│   ├── rpc.ts                        # typed RPC envelope + callRpc()
│   └── backup.ts · zip.ts            # backup / restore / debug bundle (page-side)
├── background/
│   ├── index.ts                      # SW entry, all chrome.* listeners
│   ├── queue.ts                      # serial event queue
│   ├── messaging.ts                  # RPC dispatch switch
│   └── state.ts                      # in-memory tab state → chrome.storage.session
├── ml/
│   ├── aggregate.ts                  # incremental + batch aggregation, exact decay
│   ├── sources.ts                    # live AggregateSource
│   ├── pit.ts · walk.ts              # point-in-time replay + switch-point walker
│   ├── candidate-features.ts         # the one Head A feature builder
│   ├── features.ts                   # feature extraction + names arrays + transforms
│   ├── timeseries.ts                 # visit velocity + session context
│   ├── cleanup.ts                    # Head B (cleanup recommender)
│   ├── recommend.ts                  # Head A (open recommender) + candidate pool
│   ├── rf-train.ts · eval.ts         # forest, replay warm-up, backtest/replay eval
│   ├── flush.ts · lazy.ts            # batched writes, cached loads
│   ├── pins.ts                       # pin reranker (Head A consumer)
│   ├── insights.ts                   # heatmap + today recap
│   ├── persistence.ts                # KV load/save (model + bandit + embedding)
│   ├── data-ops.ts                   # flush / invalidate hooks · wipe · reset · inspect
│   ├── stash.ts · workspaces.ts      # session-style helpers
│   ├── math.ts                       # sigmoid · sampleBeta · Welford · softmax
│   ├── embedding-train.ts            # nightly skip-gram batch
│   ├── history-bootstrap.ts          # one-time history import on install
│   └── models/
│       ├── logreg.ts                 # OnlineLogReg (Adam + L1 + Platt)
│       ├── bandit.ts                 # BetaBandit
│       └── embedding.ts              # SkipGramEmbedding
└── dashboard/
    ├── main.tsx · theme.ts · styles.css · App.tsx
    ├── api/recommendations.ts        # SW RPC client wrappers + page-side backup I/O
    ├── liveRefresh.ts                # visibility-gated, debounced refresh
    ├── components/
    │   ├── AppHeader · NavSearchBar · AiAssistant · MagicBall · AugurMark
    │   ├── Greeting · TodayRecap · PinsRow · Suggestions · OracleHint
    │   ├── TabWall · InlineCleanupCard · StashSection · WorkspacesSection
    │   ├── Insights · LearningEmptyState · SettingsDialog
    │   ├── ModelDebugPanel · SetAsHomepageGuide · Onboarding · Toaster
    ├── hooks/
    │   ├── useTabs · usePins · useSmartPinSort · useUserName
    │   ├── useDataSummary · useSearchEngine
    │   ├── useRecentSearches · useSearchSuggestions
    │   └── useGeminiChat            # Prompt API + cross-tab storage sync
    └── i18n/{index.ts, en.json, zh.json}
public/
├── _locales/{en,zh_CN}/messages.json # MV3 manifest-level i18n
├── icons/icon.svg                    # source for build-time PNG generation
└── demo/                             # README screenshots; stripped from zip
```

## See also

- [DESIGN.md](./DESIGN.md) — what each component looks like and why
- [ML.md](./ML.md) — what `ml/` does in detail
- [STORAGE.md](./STORAGE.md) — every table and key
- [API.md](./API.md) — every RPC variant
