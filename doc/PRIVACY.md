# Privacy · 隐私

What Augur observes, where it stores it, and what (if anything) leaves the browser. · Augur 看到了什么、存哪、什么会出浏览器（基本没有）。

---

## 1. The promise

> **Local-first.** Every event, every feature vector, every model weight, every bandit posterior, every embedding lives on the user's device. No telemetry, no analytics, no error reporting, no cloud sync, no remote calls — except for one footnote (favicons, see §3).

This is not just a marketing claim — it's a constraint that shaped every architectural decision:

- The ML pipeline runs in the service worker, not on a server.
- The chat assistant uses Chrome's on-device Gemini Nano, not a hosted API.
- The history bootstrap reads from `chrome.history` (local), not from any sync service.
- The manifest declares no `host_permissions` — the extension cannot, by design, reach out to arbitrary websites.

## 2. What Augur observes

The service worker listens to these `chrome.*` events:

| Event | Why |
|---|---|
| `chrome.tabs.onCreated` | Track tab opens for frequency / temporal patterns |
| `chrome.tabs.onUpdated` | Catch URL navigations + flag/title changes |
| `chrome.tabs.onRemoved` | Train cleanup head with implicit close labels |
| `chrome.tabs.onActivated` | Focus-segment accounting (which tab the user is actually looking at) |
| `chrome.windows.onFocusChanged` | Pause focus accounting when the browser loses focus |
| `chrome.idle.onStateChanged` | Pause focus accounting when the user goes idle |
| `chrome.alarms.onAlarm` | Periodic decay, embedding retraining |
| `chrome.history.search` (one-time) | First-install bootstrap |

Each event becomes a row in `db.events` with fields like `ts`, `type`, `tabId`, `windowId`, `url`, `domain`, `title`, `focusMs`, `focusCount`. Full type in [`shared/types.ts`](../src/shared/types.ts).

**Filtered out** before logging (in [`isTrackable()`](../src/background/index.ts)):
- `chrome://*` URLs
- `chrome-extension://*` URLs (including the dashboard itself)
- `edge://`, `about:` URLs
- `file://` URLs
- `javascript:` URLs

So Augur sees: every regular http(s) tab you open. It doesn't see: settings pages, other extensions, local files, javascript bookmarks.

## 3. What leaves the browser

**Exactly one outbound request type, by Augur's own code:** favicon URLs.

When a tab in the wall (or a suggestion / pin) doesn't expose `tab.favIconUrl`, Augur falls back to `https://www.google.com/s2/favicons?sz=64&domain=<hostname>` to render an icon. The browser issues a GET to Google's favicon service with just the hostname.

This is the **only** outbound traffic from Augur's own code. To kill it: remove the fallback in [`TabWall.tsx`](../src/dashboard/components/TabWall.tsx) and [`Suggestions.tsx`](../src/dashboard/components/Suggestions.tsx). The dashboard then renders generic `LanguageIcon` placeholders for tabs without a native favicon.

### A second exception: Chrome's built-in Gemini Nano

When the user opens **Augur AI** (the wand button in the nav) and sends their first prompt:

- Chrome may download the Gemini Nano model (~2-3 GB, one time, by Chrome — not by Augur).
- All subsequent prompts and responses run **on-device** via the [Prompt API](https://developer.chrome.com/docs/ai/prompt-api). No prompt or response leaves the browser.

The Prompt API is exposed as `window.LanguageModel`. Augur calls `LanguageModel.create()` and `session.promptStreaming()` — both of which route to Chrome's own on-device runtime. Augur does not (and cannot) route prompts to any cloud service.

If the user's device cannot run Gemini Nano (insufficient disk, unsupported GPU), the assistant gracefully degrades and shows an explanation pointing at `chrome://on-device-internals`.

## 4. Where it's stored

See [STORAGE.md](./STORAGE.md) for the full schema. Summary:

- **IndexedDB** (`augur` database) — all events, feedback, domains, cooccurrence, model weights, bandit state, embeddings, stash, workspaces, pins.
- **`chrome.storage.session`** — runtime tab cache, focused tab id, idle state, AI chat history (current session).
- **`localStorage`** — UI prefs (user name, theme, search engine, etc.).

All three live in the user's local browser profile. None of them sync to any cloud.

## 5. Manifest permissions

Declared in [`src/manifest.ts`](../src/manifest.ts):

| Permission | What it grants | How Augur uses it |
|---|---|---|
| `tabs` | Read tab URL/title, query, create, update, remove | Tab wall, focus tracking, newtab redirect |
| `tabGroups` | Read tab group titles + colors | Cleanup feature `isInNamedGroup`, optional grouping in workspaces |
| `history` | Read browser history | One-time bootstrap on install (`chrome.history.search` + `getVisits`) |
| `topSites` | Read top sites list | Cold-start fallback in suggestions |
| `sessions` | Read recently closed sessions | Reserved for future "restore recent" UX (not yet wired up) |
| `bookmarks` | Read bookmarks | Reserved for future bookmark-aware suggestions (not yet wired up) |
| `storage` | Use `chrome.storage.session` / `local` | Runtime state, AI chat sync |
| `alarms` | Schedule periodic tasks | Heartbeat, decay, embedding retrain |
| `idle` | Detect idle state | Pause focus accounting; `isIdle` cleanup feature |

**No `host_permissions`** — Augur literally cannot inject scripts into your tabs or read their content. It only sees what the `tabs` API exposes (URL, title, favicon URL, pinned state, group id).

## 6. AI assistant — separate trust boundary

Augur AI is built on Chrome's built-in Gemini Nano (Prompt API), not on Augur's own infrastructure. Privacy properties:

- **Model runs on-device.** Prompts never leave Chrome.
- **Model is downloaded by Chrome, not Augur.** First-use triggers a ~2-3 GB download from Google's servers (the same way Chrome's Translation API downloads language packs). After that, fully offline.
- **Chat history is local.** Stored in `chrome.storage.session` (browser-session lifetime). Auto-cleared after 30 minutes of inactivity, or via the manual refresh button in the panel header.
- **Cross-tab sync is local.** Multiple dashboard tabs share the conversation via `chrome.storage.session.onChanged`, no network involved.

The assistant cannot send your prompts to any remote service — there's no API key, no network call, no host permission. If you'd rather not have it: simply don't click the wand button.

## 7. Browser history bootstrap

On first install, Augur reads up to 5000 history entries from the last 30 days via `chrome.history.search` (and per-URL `chrome.history.getVisits` for the top 200) and writes them into `db.events` as synthetic `'navigate'` rows. This is what lets the cleanup and recommendation models be useful on day one instead of after a week of accumulated live events.

The history data:
- Is read from Chrome's local history database
- Is written into Augur's local IndexedDB
- Never crosses the network
- Is tagged in `db.events` with `meta.source = 'history-bootstrap'` for traceability and re-seed cleanup

## 8. Wipe procedure

**Settings → Data → "Wipe all data"** is destructive and irreversible. It:

1. Clears every Dexie table — events, feedback, domains, cooccurrence, kv (including all model weights and embeddings), stash, workspaces, pins.
2. Clears `chrome.storage.session`.
3. Removes `localStorage['augur:onboarded']` so the welcome dialog reappears.
4. Reloads the dashboard.

After wiping, the model is back to cold-start. Re-seed from history via the same Settings tab if desired.

## 9. Export

**Settings → Data → "Export JSON"** downloads every Dexie table as a single JSON file. Useful for:
- Auditing what Augur has on you
- Migrating to another browser profile
- Backing up before a clean OS reinstall

The export is plain JSON — readable in any text editor.

## 10. What Augur is not

- Not an analytics tool. Nothing is reported to anyone.
- Not a sync service. Augur on machine A and Augur on machine B share nothing.
- Not a behavioral fingerprinting tool. The data lives only on the device that generated it.
- Not a sales channel for ad networks. There is no business model, no third-party integration, no monetization.

## See also

- [STORAGE.md](./STORAGE.md) — exact list of stored fields and where each lives
- [ML.md](./ML.md) — what's done with the data once it's stored
- [LICENSE](../LICENSE) — MIT
