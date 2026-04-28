# API · RPC reference

The typed RPC contract between dashboard and service worker. Every variant of `RpcRequest` and `RpcResponse`. · dashboard 与 SW 之间的类型化 RPC 协议。

---

## 1. Mechanism

Single channel: `chrome.runtime.sendMessage` from dashboard → SW. The SW responds via the callback. There are no SW-initiated messages today (the dashboard polls or subscribes to storage changes when it needs cross-tab updates).

Both directions are typed via discriminated unions in [`src/shared/rpc.ts`](../src/shared/rpc.ts):

```ts
export type RpcRequest = { kind: 'recommend.open' } | { kind: 'recommend.cleanup' } | … ;
export type RpcResponse = { ok: true; kind: 'recommend.open'; data: OpenCandidate[] } | … | { ok: false; error: string };
```

The `callRpc<R>()` helper wraps `sendMessage`, rejects on `chrome.runtime.lastError` or `ok === false`, and resolves with the typed response.

Dashboard-side wrappers in [`src/dashboard/api/recommendations.ts`](../src/dashboard/api/recommendations.ts) provide convenience functions like `fetchOpenRecommendations()`, `reportCleanupFeedback()`, etc. Components should use these wrappers, not call `callRpc` directly.

The SW-side dispatch is a single `switch (req.kind)` in [`src/background/messaging.ts`](../src/background/messaging.ts).

## 2. Recommendations · 推荐

### `recommend.open`

Get the top open-recommendation candidates for the current dashboard view.

```ts
Request:  { kind: 'recommend.open' }
Response: { ok: true; kind: 'recommend.open'; data: OpenCandidate[] }
```

**Side effect**: records bandit impressions for the returned candidates.

Wrapper: `fetchOpenRecommendations()`. Used by `Suggestions.tsx`, `OracleHint.tsx`.

### `recommend.cleanup`

Get up to 5 cleanup candidates above the `SCORE_THRESHOLD` (0.55).

```ts
Request:  { kind: 'recommend.cleanup' }
Response: { ok: true; kind: 'recommend.cleanup'; data: CleanupCandidate[] }
```

**Side effect**: records bandit impressions.

Wrapper: `fetchCleanupRecommendations()`. Used by `InlineCleanupCard.tsx`.

### `recommend.cleanup.all`

Get all cleanup candidates above threshold (capped at 50). Powers the smart-cleanup batch in TabWall.

```ts
Request:  { kind: 'recommend.cleanup.all'; limit?: number }
Response: { ok: true; kind: 'recommend.cleanup.all'; data: CleanupCandidate[] }
```

`limit` is clamped to 50 server-side regardless of client value. Side effect: records bandit impressions.

Wrapper: `fetchAllCleanupCandidates()`. Used by `TabWall.tsx`.

## 3. Feedback · 反馈

### `feedback.cleanup`

Send explicit user feedback on a cleanup suggestion. Trains both the LR head and the bandit arm.

```ts
Request: {
  kind: 'feedback.cleanup';
  domain: string;
  reason: string;                            // from CleanupCandidate.reason
  features: CleanupFeatures;                 // from CleanupCandidate.features
  action: 'accepted' | 'dismissed' | 'snoozed' | 'dismissed-after-suggestion';
}
Response: { ok: true; kind: 'ack' }
```

Action semantics (and weights in [`trainCleanupFeedback`](../src/ml/cleanup.ts)):

| Action | Label | Weight | Bandit |
|---|---|---|---|
| `'accepted'` | 1 | 1.0 | accept |
| `'dismissed'` | 0 | 1.0 | dismiss |
| `'snoozed'` | 0 | 0.5 | ignore (β += 0.5) |
| `'dismissed-after-suggestion'` | 0 | **2.0** | dismiss |

Wrapper: `reportCleanupFeedback()`. Used by `InlineCleanupCard` (accept/dismiss/snooze) and `TabWall.flushSmartCleanupFeedback` (accepted vs dismissed-after-suggestion based on whether the user kept the AI's auto-check).

### `feedback.open`

Send explicit feedback on an open recommendation (e.g., user clicked an OracleHint slot).

```ts
Request: {
  kind: 'feedback.open';
  domain: string;
  features: RecommendFeatures;
  action: 'accepted' | 'dismissed' | 'ignored';
}
Response: { ok: true; kind: 'ack' }
```

Wrapper: `reportOpenFeedback()`. Used by `OracleHint`, `Suggestions`.

## 4. Insights · 洞察

### `insights.get`

The insights bundle (heatmap, top domains, etc.).

```ts
Request:  { kind: 'insights.get' }
Response: { ok: true; kind: 'insights.get'; data: InsightsBundle }
```

Wrapper: `fetchInsights()`. Used by `Insights.tsx`.

### `insights.today`

Today recap (5 stats: tabs first-seen today, domains, focus minutes, top domain, busiest hour).

```ts
Request:  { kind: 'insights.today' }
Response: { ok: true; kind: 'insights.today'; data: TodayRecap }
```

Wrapper: `fetchTodayRecap()`. Used by `TodayRecap.tsx`. Refreshes every 60 s while the dashboard is mounted.

## 5. Pins · 置顶

### `pins.rerank`

Run Head A's predictor on a list of pinned URLs and return them re-ordered.

```ts
Request:  { kind: 'pins.rerank'; pins: PinRerankInput[] }
Response: { ok: true; kind: 'pins.rerank'; data: PinRerankRow[] }
```

Each `PinRerankRow` includes the original URL plus the model's score. Caller (in `usePins.ts`) reorders the displayed pins accordingly. Throttled — see the 6-h drag cooldown.

Wrapper: `rerankPinsViaModel()`.

## 6. Stash · 暂存

### `stash.add`

```ts
Request:  { kind: 'stash.add'; items: StashInput[] }
Response: { ok: true; kind: 'stash.add'; data: number[] }   // ids of created rows
```

### `stash.list`

```ts
Request:  { kind: 'stash.list' }
Response: { ok: true; kind: 'stash.list'; data: StashedTab[] }
```

### `stash.unstash`

```ts
Request:  { kind: 'stash.unstash'; id: number }
Response: { ok: true; kind: 'ack' }
```

Removes from stash and opens the URL in a new tab.

### `stash.delete`

```ts
Request:  { kind: 'stash.delete'; ids: number[] }
Response: { ok: true; kind: 'ack' }
```

Wrappers: `stashItems`, `listStashedItems`, `unstashItem`, `deleteStashedItems`. Used by `TabWall`, `StashSection`.

## 7. Workspaces · 工作区

### `workspace.list`

```ts
Request:  { kind: 'workspace.list' }
Response: { ok: true; kind: 'workspace.list'; data: Workspace[] }
```

### `workspace.save`

```ts
Request:  { kind: 'workspace.save'; name: string; tabs: WorkspaceTab[] }
Response: { ok: true; kind: 'workspace.save'; data: number }   // new id
```

### `workspace.update`

```ts
Request: {
  kind: 'workspace.update';
  id: number;
  name?: string;
  tabs?: WorkspaceTab[];
}
Response: { ok: true; kind: 'ack' }
```

Either `name` or `tabs` (or both) — for rename or capture-current-tabs.

### `workspace.delete`

```ts
Request:  { kind: 'workspace.delete'; id: number }
Response: { ok: true; kind: 'ack' }
```

### `workspace.restore`

```ts
Request: {
  kind: 'workspace.restore';
  id: number;
  mode: 'newWindow' | 'currentWindow';
}
Response: { ok: true; kind: 'ack' }
```

Wrappers: `listWorkspaces`, `saveWorkspace`, `renameWorkspace`, `updateWorkspaceTabs`, `deleteWorkspaceById`, `restoreWorkspace`.

## 8. Tab control · 标签控制

### `closeTabs`

```ts
Request:  { kind: 'closeTabs'; tabIds: number[] }
Response: { ok: true; kind: 'ack' }
```

Wrapper: `closeTabs()` in `useTabs.ts`.

### `openUrl`

Used by Augur AI when it needs the SW to open a URL (avoids cross-origin issues).

```ts
Request:  { kind: 'openUrl'; url: string }
Response: { ok: true; kind: 'ack' }
```

Wrapper: `openUrlViaSw()`.

## 9. Data ops · 数据管理

### `data.summary`

Counts and timestamps shown in Settings → Data.

```ts
Request:  { kind: 'data.summary' }
Response: { ok: true; kind: 'data.summary'; data: DataSummary }
```

### `data.export`

```ts
Request:  { kind: 'data.export' }
Response: { ok: true; kind: 'data.export'; data: DataDump }
```

The dashboard wraps the response in a Blob and triggers a download.

### `data.wipe`

Destructive — clears all Dexie tables, `chrome.storage.session`, and the onboarding flag.

```ts
Request:  { kind: 'data.wipe' }
Response: { ok: true; kind: 'ack' }
```

### `data.resetModels`

Softer than wipe — clears only the model + bandit + embedding KV keys. Events and aggregates are preserved.

```ts
Request:  { kind: 'data.resetModels' }
Response: { ok: true; kind: 'ack' }
```

### `data.bootstrapHistory`

Manually trigger the first-install history bootstrap. Pass `force: true` to re-seed (deletes prior bootstrap-tagged events first).

```ts
Request:  { kind: 'data.bootstrapHistory'; force?: boolean }
Response: {
  ok: true;
  kind: 'data.bootstrapHistory';
  data: { events: number; domains: number; skipped: boolean; reason?: string };
}
```

`skipped: true` means the bootstrap didn't run (already done, no `chrome.history` API, or empty history). The optional `reason` field explains which.

Wrapper: `seedFromBrowserHistory()`. Used by Settings → Data → "Seed from browser history".

## 10. Model · 模型管理

### `model.inspect`

Live model weights for the debug panel.

```ts
Request:  { kind: 'model.inspect' }
Response: { ok: true; kind: 'model.inspect'; data: ModelInspection }
```

`ModelInspection` includes per-feature weights (sorted by magnitude) for both heads, Platt calibration parameters, sample counts, top bandit arms with α/β/mean, and embedding stats with top nearest-neighbor previews.

Wrapper: `fetchModelInspection()`. Used by `ModelDebugPanel.tsx`.

### `embedding.retrain`

Manually trigger a skip-gram embedding retrain (otherwise runs every 12 h via `embeddingRetrain` alarm).

```ts
Request:  { kind: 'embedding.retrain' }
Response: { ok: true; kind: 'embedding.retrain'; data: { steps: number; vocab: number } }
```

Wrapper: `retrainEmbedding()`. Used by Settings → Advanced.

### `aggregate.rebuild`

Rebuild `db.domains` and `db.cooccurrence` from `db.events` from scratch. Used after a wipe-then-restore or manual data import.

```ts
Request:  { kind: 'aggregate.rebuild' }
Response: { ok: true; kind: 'ack' }
```

Wrapper: `rebuildAggregates()`.

## 11. Adding a new RPC

Four touch points:

1. [`src/shared/rpc.ts`](../src/shared/rpc.ts) — add the request variant to `RpcRequest`, the response variant to `RpcResponse`.
2. [`src/background/messaging.ts`](../src/background/messaging.ts) — add a `case` in the switch that calls into `ml/` or wherever and returns the typed response.
3. [`src/dashboard/api/recommendations.ts`](../src/dashboard/api/recommendations.ts) — add a wrapper function so callers don't have to deal with `r.ok && r.kind === '…'` everywhere.
4. UI usage — call the wrapper.

Type rules:
- The `kind` string literal in the response **must match** the request kind. The narrowing in dashboard wrappers depends on this.
- `data` is the only payload field on success. No naked unions like `data | null` — use `null` only for genuine "no data available" cases (`fetchTodayRecap` returns `null` when no events today).
- All errors flow through the `{ ok: false; error: string }` variant. `callRpc` rejects on this so call sites can use try/catch or `.catch()`.

## See also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — RPC's place in the bigger picture
- [ML.md](./ML.md) — what `recommend.*`, `feedback.*`, `model.inspect` operate on
- [STORAGE.md](./STORAGE.md) — what `data.*` reads and writes
