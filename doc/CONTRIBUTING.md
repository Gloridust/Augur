# Contributing · 贡献

Dev workflow, code conventions, how to add a feature without breaking things. · 开发流程、编码规范、如何安全地加新东西。

---

## 1. Setup

```bash
git clone <fork>
cd augur
npm install
npm run dev
```

`npm run dev` starts Vite + `@crxjs/vite-plugin` in watch mode. The dist updates on save, but **service-worker changes need a manual reload** in `chrome://extensions/` (click the refresh icon on Augur's card). Dashboard React changes hot-reload automatically.

To test the dashboard:
- Open a new tab — the SW redirects `chrome://newtab/` to `chrome-extension://<id>/src/dashboard/index.html`
- Or click the toolbar icon

## 2. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite watch + crxjs HMR |
| `npm run typecheck` | `tsc -b --noEmit` — strict TS check |
| `npm run icons` | Regenerate 16/32/48/128 PNGs from `public/icons/icon.svg` |
| `npm run build` | Production build to `dist/` |
| `npm run package` | `build` + zip to `augur-<version>.zip` for **local / unpacked** distribution (developer key allowed) |
| `npm run release` | Build a **Chrome Web Store-ready** zip `augur-v<version>-cws.zip` with strict pre-flight checks. See [`RELEASE.md`](RELEASE.md). |
| `npm run extension-key` | Generate a stable RSA-2048 public key for manifest's `key` field — paste into `src/manifest.ts` to keep the dev extension ID stable across rebuilds |

### Stable dev extension ID

Without a `key` in `src/manifest.ts`, Chrome derives the extension ID from the unpacked install path. **Loading the same build from a different directory creates a new extension ID with a fresh IndexedDB** — events, model weights, and saved workspaces appear wiped (they're still there under the old ID, but inaccessible).

Run `npm run extension-key` once, paste the printed string into `defineManifest({ ..., key: '...' })`, rebuild. The dev extension ID is now stable across rebuilds / re-installs, so IndexedDB persists. The Chrome Web Store overrides this field with its own production key on publish, so the dev key is safe to commit.

`prebuild` and `predev` both run `icons` so the PNG icons stay in sync with the SVG source.

## 3. The 3-boundary rule

```
src/
├── ml/             ← pure logic, IndexedDB only via shared/db
├── background/     ← all chrome.* event listeners + RPC dispatch
└── dashboard/      ← React UI; talks to background only via callRpc
```

Hard rules:

- **`ml/` doesn't import from `background/` or `dashboard/`.** Exception: `background/state.ts` for the runtime-state cache, which is a thin wrapper around `chrome.storage.session`.
- **`dashboard/` doesn't import from `background/`.** Talks via `callRpc` only.
- **`background/index.ts` registers all listeners at top level.** Don't put `chrome.*.addListener(…)` calls inside an `async function` or after an `await` — the listener won't survive an SW sleep cycle.

Why: keeps `ml/` testable, keeps the dashboard renderable even with a cold SW, makes it possible to refactor the UI without touching ML.

## 4. Code conventions

- **TypeScript strict, no `any`.** If you need `any`, the type system is telling you to define an interface or use a discriminated union.
- **No `console.log` in committed code.** `console.error` for genuine errors only. Debug prints go through the model debug panel or get removed before commit.
- **Prefer composition over inheritance.** Hooks > class hierarchies. The one OOP class in this codebase is `OnlineLogReg` — mathematical state with mutations is the right shape for it.
- **RPC is the boundary, not function imports.** Don't sneak SW logic into the dashboard via dynamic import. If the dashboard needs new data, add an RPC.
- **No `// removed` comments, no zombie code.** If something's gone, delete it. Git remembers.
- **Comment the *why*, not the *what*.** The code says what it does; comments explain the constraint or the past incident or the surprising trade-off. See: every multi-line comment in this codebase.
- **Don't add error handling for impossible cases.** Trust internal invariants. Validate at boundaries (chrome API responses, user input).

## 5. How to add an RPC

Four touch points:

1. **[`src/shared/rpc.ts`](../src/shared/rpc.ts)** — add the request variant to `RpcRequest` and the response variant to `RpcResponse`. Both keyed by the same `kind` literal.
2. **[`src/background/messaging.ts`](../src/background/messaging.ts)** — add a `case 'your.kind':` that calls into `ml/` or wherever and returns the typed response.
3. **[`src/dashboard/api/recommendations.ts`](../src/dashboard/api/recommendations.ts)** — add a wrapper function so call sites don't deal with `r.ok && r.kind === '…'` repeatedly.
4. **UI** — call the wrapper.

Full reference in [API.md](./API.md).

## 6. How to add an ML feature

If you're adding a feature to Head A or Head B:

1. **[`src/shared/types.ts`](../src/shared/types.ts)** — add the field to `CleanupFeatures` or `RecommendFeatures`.
2. **[`src/ml/features.ts`](../src/ml/features.ts)** — append the field name to `CLEANUP_FEATURE_NAMES` or `RECOMMEND_FEATURE_NAMES`. **Append-only** — reordering breaks index-keyed weights. Then update the corresponding `buildXFeatures()` to compute the new value.
3. **[`src/ml/persistence.ts`](../src/ml/persistence.ts)** — bump the model KV key (`model:cleanup:vN` → `vN+1`) so old weights don't get mis-mapped. Add the old key to the `STALE_KEYS` array in [`background/index.ts`](../src/background/index.ts) `onInstalled` handler so it gets cleaned up on update.
4. If the new feature needs context that the existing `buildXFeatures()` arguments don't carry, extend the args object — keep the new args optional with safe defaults so existing callers (especially `trainImplicitCleanup` paths) don't break.

Full reasoning in [ML.md](./ML.md#feature-names-are-append-only).

## 7. How to add a UI component

1. New file in `src/dashboard/components/<Name>.tsx`.
2. Default to MUI primitives (`Box`, `Stack`, `Typography`, `Card`, `Button`). Custom CSS only when MUI can't express the layout.
3. Use theme tokens via `var(--mui-palette-…)` so light/dark both work.
4. Coral (`primary.main`) is the only accent. Don't introduce a new color.
5. If the component needs server data, use a hook in `src/dashboard/hooks/` that wraps the API call. Components shouldn't call `callRpc` directly.
6. i18n: every user-visible string goes in [`en.json`](../src/dashboard/i18n/en.json) and [`zh.json`](../src/dashboard/i18n/zh.json). Use `useTranslation()` and `t('namespace.key')`.
7. If the component needs density variants (compact / spacious), follow the `sizes` token pattern in [`TabWall.tsx`](../src/dashboard/components/TabWall.tsx) — single source object, read `sizes.X` everywhere.

## 8. Style notes

- **Paper aesthetic** — see [DESIGN.md](./DESIGN.md). Don't introduce shadows, gradients, or backdrop-filters that don't already exist.
- **Italiana wordmark only in the nav.** Body text stays system-serif.
- **Animation easings**: bouncy (`cubic-bezier(0.34, 1.56, 0.64, 1)`) only on Augur's distinctive surfaces (OracleHint, slot picks). Everything else uses Material's standard motion.
- **Density**: dense mode shrinks padding and font sizes by ~20%. Use it on the above-the-fold pane.

## 9. Testing

Augur has **no test suite** — the codebase is small enough and exploratory enough that manual smoke-testing has been the better fit.

When making changes that touch data or model logic, the manual checklist is:

- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds with no warnings beyond the chunk-size note
- [ ] Load `dist/` as an unpacked extension and open a new tab
- [ ] Settings → Advanced → check the model debug panel for sane weights
- [ ] Settings → Data → "Seed from browser history" runs and increments the event count
- [ ] Open a new tab to a real URL, then refresh the dashboard — TodayRecap's "tabs opened" should increment

If you're touching the UI, also verify both light and dark modes (system theme switch).

## 10. Release flow

There are two distinct flows depending on where the build is going:

**Local / private distribution** (unpacked install, sending the zip to a friend, etc):

```bash
# Bump version in package.json AND src/manifest.ts (must match)
npm run package           # → augur-<version>.zip

# chrome://extensions → Load unpacked → dist/
```

The `package` zip allows the developer `key` (for stable extension ID across rebuilds).

**Chrome Web Store submission**: see [`RELEASE.md`](RELEASE.md) for the full walkthrough — pre-flight checks, permission justifications, store listing copy, screenshots requirements, post-submission flow.

```bash
# After bumping version and confirming `key:` is commented out in src/manifest.ts:
npm run release           # → augur-v<version>-cws.zip
# Upload to https://chrome.google.com/webstore/devconsole
```

`npm run release` runs strict pre-flight checks (no `key` field, version match, no stray source maps, all icon sizes present) and aborts if anything's off. Subsequent uploads must have a higher version than the published one.

## 11. Commits and PRs

- Commit messages: focus on the *why*. The diff says what changed.
- One topic per commit. Bundling unrelated changes makes them harder to review and harder to revert.
- For non-trivial PRs that touch the model or feature pipeline, include a short paragraph in the description explaining how the change interacts with the existing surfaces (which heads it affects, whether it requires a model version bump, etc.).

## See also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — what each layer is allowed to do
- [API.md](./API.md) — full RPC contract
- [ML.md](./ML.md) — when in doubt about a feature pipeline change, this doc has the why
- [LICENSE](../LICENSE) — MIT
