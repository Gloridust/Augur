<div align="center">

<img src="public/icons/icon128.png" width="96" alt="Augur logo"/>

# Augur

**A learning new-tab dashboard for Chrome — anticipates what you'll open, organizes the tabs you've got, and chats with you via on-device Gemini. Fully local, zero telemetry.**
**·**
**一个会学习的 Chrome 新标签页——预判你接下来想打开什么、管好你已经开着的一堆标签、和本地 Gemini 边用边聊。全程本地，零遥测。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](./tsconfig.app.json)
[![Local-first](https://img.shields.io/badge/data-100%25%20local-2EA043.svg)](#privacy--隐私)
[![Built with](https://img.shields.io/badge/built%20with-Vite%20%C2%B7%20React%2018%20%C2%B7%20MUI%20v6-C2410C.svg)](#tech-stack--技术栈)
[![Bundle](https://img.shields.io/badge/bundle-~280%20KB%20zip-555.svg)](#releasing--%E5%8F%91%E5%B8%83)

</div>

---

## What it is · 是什么

Augur replaces Chrome's new tab page with a calm, paper-textured dashboard built around a single idea: **the page should know what you'll need before you ask**. · Augur 用一块克制的纸面仪表板替换 Chrome 新标签页，所有设计围绕一个核心：**这一页应该在你开口前就知道你想要什么。**

Every interaction trains an on-device model — every tab open, every focus, every dismiss, every pin. The same model then powers the Pinned row, the Smart Suggestions, and the Cleanup hints, so a signal you give in one place sharpens everything else. · 每一次交互都在训练一个**完全本地的模型**——开标签、聚焦、忽略、置顶。同一个模型再驱动「置顶行」「智能推荐」「清理建议」这三处，你给的任何一个信号都会让所有推荐一起变聪明。

Nothing leaves your browser. Ever. · 没有任何数据离开浏览器，永远不会。

---

## Demo · 截图

![homepage](public/demo/Screenshot%202026-04-27%20at%2001.11.18.png)

![setting1](public/demo/Screenshot%202026-04-27%20at%2001.11.30.png)

![setting2](public/demo/Screenshot%202026-04-27%20at%2001.11.38.png)

![setting3](public/demo/Screenshot%202026-04-27%20at%2001.51.52.png)

## Features · 功能

### 🔮 Anticipation · 预判

- **Oracle Hint** — when the model is genuinely confident (top candidate ≥ 0.55 calibrated), a Dynamic-Island capsule slides in at the top of the new tab with the three most-likely sites. ←/→ navigates, Enter opens, Esc dismisses, auto-hides after 3 s. · **灵动岛预测**：模型对"你下一步要打开什么"高把握时（top 候选概率 ≥0.55），新标签页顶部会弹出灵动岛胶囊，列出三个最可能的站点。←/→ 切换、Enter 打开、Esc 关闭，3 秒未操作自动消失。
- **Smart Suggestions** rerank ~80 candidate domains every time the focused tab changes — model considers frecency, time-of-day, day-of-week, recency, embedding similarity to current page, last-24h velocity, and "did I just visit this in the past 30 min". · **智能推荐**每次切换聚焦标签都会对 ~80 个候选域名重排，模型同时看：衰减频次、时段、星期、最近访问、与当前页的嵌入相似度、最近 24 小时访问速度、最近 30 分钟会话上下文。
- **Pin row** uses the same model — pins reorder by predicted relevance, with a 6-hour cooldown after you drag so manual arrangements stick. · **置顶行**用同一个模型——按预测相关度自动重排，但**手动拖动后 6 小时内冻结**，保证你刚整理好的不被打散。
- **Cleanup card** flags open tabs you're about to abandon. Three-key feedback (close / stash / keep) trains the model in real time. · **清理卡片**标记你即将放弃的标签。三键反馈（关掉 / 暂存 / 保留）实时训练模型。

### 🪄 Augur AI · 本地 AI 对话

- Magic-wand button in the nav opens a small chat panel powered by Chrome's built-in **Gemini Nano** (Prompt API, Chrome 138+). · 顶栏的魔法棒按钮打开一个小型聊天面板，由 Chrome 内置 **Gemini Nano**（Prompt API，Chrome 138+）驱动。
- **No API key, no network call, no log leaves the browser** — the model runs on-device. First use triggers a one-time ~2-3 GB download with progress bar. · **无需 API key、不联网、无日志外传**——模型在本机运行。首次使用会触发约 2-3 GB 模型下载，附带进度条，仅一次。
- **Cross-tab synced** via `chrome.storage.session` — open Augur in two tabs and they share the same conversation in real time, streaming text appears in both. · **跨标签同步**：用 `chrome.storage.session` 存储，开两个 Augur 标签会共享同一段对话，回答流式生成时两边都能看到字一个个出来。
- Auto-clears after 30 minutes of inactivity (timer anchored to `lastActivity` in storage), or click the refresh icon for an immediate wipe. Stop button aborts an in-flight stream. · 30 分钟无新消息自动清空（基于存储中的 `lastActivity`），也可点刷新图标手动清。流式回答中可点停止。

### 🗂 Tab management · 标签管理

- **Group by domain or by window** with deterministic per-window color stripes. · **按域名或按窗口分组**，每个窗口有稳定的颜色条。
- **Full keyboard control**: ↑↓ moves focus, Space selects, Enter activates, Delete closes, ⌘A selects all. · **全键盘可控**：方向键移焦、Space 选中、Enter 跳转、Delete 关闭、⌘A 全选。
- **Bulk close / bulk stash** with a 3-key feedback loop into the cleanup model. · **批量关闭 / 批量暂存**，反馈直接喂给清理模型。
- **Stash** parks tabs into a holding pen instead of closing — one click to restore. · **暂存**把标签放进侧边收纳区，不真的关掉，一键恢复。

### 🎯 Workspaces · 工作区

- Save the current set of tabs as a named session. Restore into the current window or a new one. · 把当前标签集保存为命名会话，可在当前窗口或新窗口恢复。
- Update / rename / delete from a tap menu. · 三点菜单可重命名、覆盖更新、删除。

### 🌅 Today · 今日

- Glanceable strip: tabs opened today, domains visited, focus minutes, top domain, busiest hour. Hidden until there's data. · 一条信息：今天打开的标签、访问域名、专注分钟、Top 域名、最忙时段；没数据时自动隐藏。
- Focus heatmap (day × hour) over the last 30 days. · 近 30 天的「星期 × 小时」专注热力图。

### 🔍 Built-in web search · 内置搜索

- Nav search bar with **Google / Bing toggle (remembered)**, auto-suggest, recent searches, ⌘K to focus. · 顶栏搜索条，**Google / Bing 切换并记住选择**、实时建议、最近搜索、⌘K 聚焦。

### ✨ The little things · 一点小事

- Italiana display wordmark · Iowan / Charter / Source Serif body — paper aesthetic throughout. · Italiana 衬线 wordmark + 系统衬线正文，整套纸面美学。
- 3D mechanical "expansion ball" greeting mark that follows your cursor. · 问候语左侧是会跟随光标转动的 3D 机械伸缩球。
- Onboarding modal with privacy promise + learning-progress widget. · 首次引导：隐私承诺 + 实时学习进度。
- Settings dialog: name, language, data export / wipe, **model debug panel** with live LR coefficients + bandit α/β + nearest-neighbor preview. · 设置面板：姓名、语言、数据导出 / 清除、**模型调试面板**（实时 LR 系数 + bandit α/β + 最近邻预览）。
- Toast feedback for every destructive action. · 每个破坏性操作都有 toast 反馈。

---

## Quick start · 快速开始

```bash
git clone https://github.com/YOUR_HANDLE/augur.git
cd augur
npm install
npm run package          # produces augur-<version>.zip + dist/
```

Then in Chrome / Edge / Brave: · 在 Chrome / Edge / Brave 里：

1. `chrome://extensions` → toggle **Developer mode** (top-right). · `chrome://extensions` → 右上角开**开发者模式**。
2. **Load unpacked** → select `dist/`. · **加载已解压的扩展程序** → 选 `dist/`。
3. Open a new tab — that's it. · 开个新标签页——搞定。

> **Heads-up:** Chrome attaches a "Customize Chrome / extension name" footer to *any* page registered as a newtab override, and the role sticks once attached — no JS / redirect / CSS can detach it. Augur dodges that by NOT registering an override and instead listening to `chrome.tabs.onCreated`, rewriting `chrome://newtab/` → its dashboard URL via `chrome.tabs.update` *before* Chrome assigns the newtab role. Same convenience, no Chrome footer. Tradeoff: Chrome's anti-focus-stealing policy holds the omnibox focus on ⌘T, so Oracle Hint's ←/→ keyboard nav only activates after you click anywhere on the page or press Tab once (mouse always works). · **小提示**：Chrome 给所有"newtab override"的页面强制挂底部条，且 newtab 角色一旦标记就摘不掉——JS/重定向/CSS 都不行。Augur 选择**不**注册 override，而是用 `chrome.tabs.onCreated` 在 Chrome 给 tab 标记 newtab 角色**之前**就把 `chrome://newtab/` 改写到 dashboard URL，等效但没有底部条。代价是：⌘T 后地址栏被 Chrome 锁住焦点，**灵动岛**胶囊的左右键要等用户随便点一下页面或按一次 Tab 才会响应（鼠标始终可用）。

---

## Architecture · 架构

```
┌─ Service Worker ───────────────────────────────┐
│  chrome.tabs / windows / idle / alarms events  │
│             │                                   │
│             ▼                                   │
│       Event logger ──► IndexedDB (Dexie)        │
│             │                                   │
│             ▼                                   │
│   Aggregator (domain stats, co-occurrence,     │
│               time-series velocity, sessions)   │
│             │                                   │
│             ▼                                   │
│   ┌── Head A · Open recommender ─────────────┐ │
│   │   features → LogReg(11) → Bandit         │ │
│   │   + Skip-gram embeddings (32-dim)        │ │
│   │   + Platt calibration (a, b)             │ │
│   └──┬───────────────────────────────────────┘ │
│      │                                          │
│      └──► Smart Suggestions │ Pin reranking │  │
│           Cold-start candidate generation       │
│                                                 │
│   ┌── Head B · Cleanup recommender ──────────┐ │
│   │   features → LogReg(14) → Bandit         │ │
│   │   + Platt calibration (a, b)             │ │
│   └──┬───────────────────────────────────────┘ │
│      │                                          │
│      └──► Inline cleanup card                   │
└────────────────────────────────────────────────┘
                          ▲
                          │ chrome.runtime.sendMessage
                          │ (typed RpcRequest union)
                          ▼
┌─ Dashboard (new-tab page) ────────────────────┐
│  React 18 + MUI v6 (paper theme)               │
│  i18next (en / zh)                             │
│  Pins · Suggestions · TabWall · Cleanup        │
│  Stash · Workspaces · Insights · Settings      │
└────────────────────────────────────────────────┘
```

### Why one model for everything · 为什么用一个模型

Three places need to answer "is this URL relevant **right now** for **this user**?": Smart Suggestions, the Pin row, and (in cold-start) the candidate generator. Sharing one model means: · 三个地方都要回答"这个 URL 此刻对这个用户有多相关"：智能推荐、置顶行、冷启动候选生成。共享一个模型的意义：

1. A click on a Smart Suggestion improves your Pin order. A drag on a Pin doesn't directly train the model, but everything you do *around* that pin (visit, focus, cooccurrence) does. · 点击智能推荐 → Pin 排序变好；拖动 Pin 本身不训模型，但围绕这个 Pin 的访问 / 聚焦 / 共现都会。
2. There's one set of weights, one bandit, one set of embeddings to debug, calibrate, and inspect. · 只有一组权重、一个 bandit、一组 embedding 要调试、校准、检视。
3. The model gets ~3-5× more training samples than three separate models would. · 模型拿到的样本量是三个独立模型的 3-5 倍。

### Feature pipeline · 特征管线

Every recommendation features include: · 每条推荐都包含：

| Family · 类 | Features · 特征 |
|---|---|
| **Frecency · 衰减频次** | `freqDecay` (Σ exp(-Δt/τ), τ=14d) · 域名级访问衰减 |
| **Engagement · 投入度** | `avgFocusMs`, `domainCloseQuickRate`, `domainCloseWithoutFocusRate` (Cleanup head only) |
| **Temporal · 时段** | `hourMatch`, `dowMatch` — softmaxed hour & day-of-week histograms · 24×7 直方图 softmax |
| **Cyclic time · 周期编码** | `hourSin`, `hourCos`, `dowSin`, `dowCos` — sin/cos projection so 23h ≈ 0h · 让模型在邻近时段间平滑泛化 |
| **Recency · 最近性** | `recencyHours` since last visit |
| **Time-series · 时序** | `visitVelocity` (24h vs 14d baseline), `sessionContext` (visited in last 30 min) |
| **Co-occurrence · 共现** | `cooccurrenceWithFocused` — pair counts within 5-min windows, decayed (τ=30d) |
| **Embedding · 嵌入** | `embedSimToFocused` — cosine in 32-dim skip-gram space, retrained every 12h on co-occurrence |
| **State · 状态** | `isCurrentlyOpen`, `isPinnedSomewhere` |

The cleanup head additionally uses per-tab + per-window state: `tabAgeMs`, `timeSinceFocusMs`, `focusMs`, `focusCount`, `focusRate`, `isPinned`, `isGrouped`, `sameDomainOpenCount`, `embedSimToOpen`, `isDiscarded`, `tabIndex` (normalized position in window strip), `isInActiveWindow`, `windowSameDomainCount`, `isInNamedGroup`, `navCount` (in-tab navigations since open), `isIdle` (system-level chrome.idle state). Tabs with `tab.audible === true` are hard-excluded from candidates — never auto-flagged regardless of model score. · 清理头额外用每个标签 + 所在窗口的状态特征；正在播放音视频的 tab 被硬性排除，不会被模型勾选。

### Online training · 在线学习

```
predict      = sigmoid(calibA · z + calibB)              ← Platt calibration
            where z = w·standardize(x) + bias

update(x, y, weight) =
  Adam step on z (lr=0.01, β1=0.9, β2=0.999, ε=1e-8)
  + L2 (1e-4) added to gradient
  + L1 (1e-5) proximal soft-threshold on weights → sparsity
  + Platt SGD on (calibA, calibB) once trainedSamples ≥ 20
  + Bandit α += accept ? weight : 0, β += dismiss ? weight : 0

weight = 0.5  (snoozed)
       | 1.0  (accepted | dismissed)
       | 2.0  (dismissed-after-suggestion — user toggled off an AI auto-pick)
```

The Beta-Bernoulli bandit per `(domain, reason)` arm makes "you keep ignoring this kind of suggestion → stop suggesting it" emerge from data, no hand-coded rules. · 按 `(domain, reason)` 维护 Beta 后验，「你一直忽略这种建议 → 不再推荐」自然从数据里浮现，零规则。

Smart-cleanup auto-select uses an **uncertainty-rejection threshold** of 0.60 calibrated probability (vs. 0.55 for "show as candidate") — predictions in the [0.55, 0.60) band are still surfaced in the cleanup card but never auto-checked, since the cost of a false positive is higher when the user might one-click close them. · 一键清理的自动勾选用 0.60 的不确定区拒绝阈值（候选列表是 0.55），落在 [0.55, 0.60) 的预测仍会显示但不会被自动选中——一键场景下误关代价更高。

---

## Tech stack · 技术栈

| Layer · 层 | Choice · 选型 |
|---|---|
| Build | Vite + `@crxjs/vite-plugin` (Manifest V3) |
| Language | TypeScript (strict, no `any`) |
| UI | React 18 + MUI v6 with a custom paper theme |
| Display font | Italiana (wordmark) + system serif (Iowan / Charter / Cambria) |
| Persistence | Dexie (IndexedDB) — 7 tables, 4 schema versions |
| RPC | `chrome.runtime.sendMessage` with a typed `RpcRequest` discriminated union |
| ML | Hand-rolled online LR · Welford z-score · Beta-Bernoulli Thompson sampling · Skip-gram (32d) · Platt scaling — **no TF.js, no ONNX, no chart library** |
| Built-in AI | Chrome's Prompt API (`window.LanguageModel`, Chrome 138+) — Gemini Nano on-device, no key, no host permissions, no network |
| Icons | Resvg (`@resvg/resvg-js`) renders 16 / 32 / 48 / 128 PNGs from one SVG source at build time |

Total bundle: **~600 KB raw / ~180 KB gzipped**, zip ~280 KB. · 总打包：原始 ~600KB / gzip ~180KB，zip ~280KB。

---

## Privacy · 隐私

Augur is local-first with one shadow on its conscience: it currently fetches favicons from `https://www.google.com/s2/favicons?…` for sites you've already visited. That's the **only** outbound traffic from Augur's own code. Disable it by removing the fallback in `TabWall.tsx` / `Suggestions.tsx`. · Augur 本地优先，自身代码唯一的对外网络请求是 `https://www.google.com/s2/favicons?…` 抓取你已经访问过的站点的 favicon。禁掉只需删 `TabWall.tsx` / `Suggestions.tsx` 里的 fallback。

> Augur AI talks to Chrome's built-in Gemini Nano via the on-device Prompt API — prompts and responses never leave the browser. The model itself is downloaded once by Chrome (not by Augur) the first time you use the assistant, and lives in Chrome's own storage afterwards. · Augur AI 通过浏览器的本地 Prompt API 调用内置 Gemini Nano，对话内容不离开浏览器。模型本体由 Chrome（非 Augur）在你首次使用时下载一次，之后存在 Chrome 自己的存储里。

- **No telemetry, no analytics, no error reporting.** · 无埋点、无遥测、无错误上报。
- **No cloud sync.** Events, model weights, bandit posteriors, embeddings, stash, workspaces, and pins all live in IndexedDB (`augur` database). Dexie schema is **purely additive** — extension updates never drop or migrate destructive data. · 无云同步，全部在 `augur` IndexedDB 数据库里。Dexie schema **纯追加式**——扩展更新永远不会破坏性迁移数据。
- **No host permissions.** The manifest declares `tabs`, `tabGroups`, `history`, `topSites`, `sessions`, `storage`, `alarms`, `idle` — and nothing else. The install dialog is short and reads like a normal productivity extension. · 无 host 权限，安装弹窗短小，看着就是普通生产力扩展。
- **Wipe at any time.** Settings → Data → Wipe — clears every table, resets onboarding, deletes localStorage prefs. · 随时清除，设置 → 数据 → 清除，重置一切。

### First-install bootstrap from browser history · 首装从浏览器历史种子

On first install, the service worker reads the user's last 30 days of Chrome history (`chrome.history.search` + `chrome.history.getVisits` for the top 200 URLs by visit count) and replays them as `navigate` events into `db.events`, then runs a full `rebuildFromEvents` so domain stats and co-occurrence are populated immediately. The model has a real distribution to learn from on day one instead of waiting days for live tab events to accumulate. The bootstrap is **gated by `chrome.runtime.onInstalled` reason === 'install'** so it never re-runs on extension update. A "Seed from browser history" button in **Settings → Data** lets the user re-run it on demand (deletes prior bootstrap-tagged events first to avoid duplicates). · 首次安装时，service worker 会读取过去 30 天的 Chrome 历史（`chrome.history.search` + 对访问最多的 200 个 URL 调 `chrome.history.getVisits` 拿真实时间分布），把它们当作 `navigate` 事件回放进 `db.events`，然后跑一次 `rebuildFromEvents` 让域名统计和共现表立刻就绪——模型从第一天起就有真实分布可学，不用等几天积累。bootstrap **只在 `chrome.runtime.onInstalled` 的 reason 是 `'install'` 时跑**，扩展更新不会重跑。**设置 → 数据**里的"从浏览器历史导入"按钮可以手动重跑（会先删掉之前 bootstrap 打过 tag 的事件，避免重复）。

### Update preservation · 更新数据保留

- **IndexedDB persists across extension updates** by Chrome contract — Dexie tables (events, feedback, domains, cooccurrence, stash, workspaces, pins, kv) survive untouched. · IndexedDB 在扩展更新时由 Chrome 保证持久化，所有 Dexie 表都不会动。
- **Dexie schema is append-only.** v1 → v4 has only added new tables; no `.upgrade()` callbacks (because none are needed — additive migrations are automatic). · Dexie schema 纯追加，v1→v4 都只加表，无破坏性迁移。
- **Stale KV keys cleanup**: When schema bumps require resetting model weights (e.g., feature-count change `model:cleanup:v2` → `v3`), the `onInstalled` handler with `reason === 'update'` deletes the stale keys via `db.kv.bulkDelete` so they don't accumulate as dead bytes. Adding to the cleanup list is safe — `bulkDelete` ignores missing keys. · 字段顺序变化要 bump 模型 KV key 时，`onInstalled` 在 `reason === 'update'` 分支用 `db.kv.bulkDelete` 删除旧 key，不会越积越多。
- **What does get reset on schema bump:** model weights only (the LR / Adam state). Events, feedback, domain stats, embeddings — all retained. The new model warms back up via incremental updates as new events come in (and immediately if the user clicks "Seed from browser history"). · bump 时只重置模型权重；事件、反馈、域名统计、嵌入都保留。新模型通过增量学习自动热起来——点一下"从浏览器历史导入"会立刻热完。

---

## Project structure · 项目结构

```
src/
├── manifest.ts                       # MV3 manifest (consumed by @crxjs)
├── shared/
│   ├── db.ts · types.ts · rpc.ts     # cross-boundary contracts
├── background/
│   ├── index.ts                      # SW entry · listeners · alarms
│   ├── messaging.ts                  # RPC dispatch table
│   └── state.ts                      # chrome.storage.session helpers
├── ml/
│   ├── aggregate.ts                  # incremental + batch aggregation
│   ├── features.ts                   # feature extraction
│   ├── timeseries.ts                 # visit-velocity & session-context
│   ├── cleanup.ts                    # Head B
│   ├── recommend.ts                  # Head A
│   ├── pins.ts                       # Pin reranker (Head A consumer)
│   ├── insights.ts                   # heatmap · today recap
│   ├── persistence.ts                # model + bandit state via kv
│   ├── data-ops.ts                   # export · wipe · reset · inspect
│   ├── stash.ts · workspaces.ts      # session-style storage helpers
│   ├── math.ts                       # sigmoid · sampleBeta · Welford · softmax
│   ├── embedding-train.ts            # nightly skip-gram batch
│   └── models/
│       ├── logreg.ts                 # OnlineLogReg + Platt
│       ├── bandit.ts                 # BetaBandit (Thompson sampling)
│       └── embedding.ts              # SkipGramEmbedding
└── dashboard/
    ├── main.tsx · theme.ts · styles.css
    ├── App.tsx
    ├── api/recommendations.ts        # SW RPC client
    ├── components/
    │   ├── AppHeader · NavSearchBar · AiAssistant · MagicBall · AugurMark
    │   ├── Greeting · TodayRecap · PinsRow · Suggestions · OracleHint
    │   ├── TabWall · InlineCleanupCard · StashSection · WorkspacesSection
    │   ├── Insights · LearningEmptyState · SettingsDialog
    │   ├── ModelDebugPanel · SetAsHomepageGuide · Onboarding · Toaster
    ├── hooks/
    │   ├── useTabs · usePins · useSmartPinSort
    │   ├── useUserName · useDataSummary · useSearchEngine
    │   ├── useRecentSearches · useSearchSuggestions
    │   └── useGeminiChat            # Prompt-API + cross-tab storage sync
    └── i18n/{index.ts, en.json, zh.json}
public/
├── _locales/{en,zh_CN}/messages.json # MV3 manifest-level strings
└── icons/
    └── icon.svg                       # source — 16 / 32 / 48 / 128 PNGs
                                       # are built from this at prebuild
```

---

## Developing · 开发

```bash
npm run dev          # Vite + CRX hot-reload · 热加载
npm run typecheck    # tsc -b --noEmit
npm run icons        # regenerate PNG icons from public/icons/icon.svg
npm run build        # production bundle in dist/
npm run package      # build + zip dist into augur-<version>.zip
```

`npm run dev` rebuilds on save. Service-worker changes need a manual reload via the extension card. · `npm run dev` 保存即编译。SW 改动需要在扩展卡片上点刷新。

### Inspecting the model live · 实时查看模型

Settings → Advanced has: · 设置 → 高级里有：

- LR coefficients sorted by magnitude · 按绝对值排序的 LR 系数
- Bias · trained samples · positive samples · Platt `a / b / n` · bias 项、训练样本数、正样本数、Platt 校准 `a / b / n`
- Bandit posteriors (top arms by impressions, with α / β / mean) · Bandit 后验（按曝光排序的 Top arms，附 α/β/均值）
- Embedding stats — vocab, training steps, last-trained time, **live nearest-neighbor preview for top 3 domains** · 嵌入统计 + Top-3 域名的最近邻
- One-click **Retrain embeddings** & **Reset models** · 一键重训嵌入、重置模型

### Debugging the service worker · 调试 SW

`chrome://extensions` → click the **service worker** link on Augur's card. DevTools opens scoped to the SW context. The SW sleeps after ~30 s of inactivity — trigger any tab event to wake it. · 在 Augur 卡片上点 **service worker** 链接打开 DevTools。SW 30 秒不活动就睡，开/关任意标签可唤醒。

---

## Releasing · 发布

Augur has **two distinct package commands** for different audiences. Pick the right one or your upload will be rejected. · Augur 有**两个不同的打包命令**，适用于不同场景。用错商店会拒收。

| Command | Output | For | Dev `key` allowed? |
|---|---|---|---|
| `npm run package` | `augur-<version>.zip` | Local install · 本地安装 | ✓ |
| `npm run release` | `augur-v<version>-cws.zip` | Chrome Web Store submission · 上架商店 | ✗ (enforced · 强制检查) |

```bash
# Local / private distribution · 本地分发
npm run package          # → augur-<version>.zip

# Chrome Web Store submission · 商店上架
npm run release          # → augur-v<version>-cws.zip with pre-flight checks
```

**`npm run release` runs strict pre-flight checks before building** (no developer `key` in manifest, version match between `package.json` and `src/manifest.ts`, all four icon sizes present, no stray source maps / .DS_Store / .vite artifacts, service worker built). Aborts if any check fails — so you can't accidentally ship a broken zip to CWS. · `npm run release` 在打包前做严格预检查：manifest 里不能有开发者 `key`、版本号必须对齐、四个尺寸的 icon 都在、不能混进 source map 和 .DS_Store、SW 必须构建成功——任一不过就直接 abort，杜绝把坏 zip 误传到商店。

**Full Chrome Web Store walkthrough** in [`doc/RELEASE.md`](doc/RELEASE.md), covering:
- Pre-release checklist (version bump, key removal, smoke test) · 发布前检查清单
- Permission justifications (paste-ready text for each of 8 declared permissions) · 8 项权限的提交文案（可直接粘贴）
- Store listing copy (EN + 简中) · 商店描述文案
- Screenshots / promotional tiles requirements · 截图与商店瓦片要求
- Common rejection reasons and fixes · 常见拒收原因及修复

---

## Roadmap · 路线图

✅ shipped · 已完成

- Core ML: online LR + bandit + skip-gram embeddings + Platt calibration · 核心 ML
- Time-series enrichment (visit velocity, session context) · 时序特征
- Pin reranker on the same Head A model · Pin 接入同一模型
- Onboarding · settings (incl. debug panel) · 引导 · 设置 · 调试面板
- Tab stash · workspaces · today recap · cleanup inline card · 暂存 · 工作区 · 今日 · 内联清理
- Web search bar with engine memory · 引擎记忆搜索栏
- Paper theme · custom mark · Italiana wordmark · 3D MagicBall · 纸面主题 · 定制 mark · 3D 球
- Full keyboard nav · ⌘K palette deprecated in favor of inline filters · 全键盘导航
- Oracle Hint dynamic-island capsule for high-confidence next-tab predictions · 灵动岛风预测胶囊
- Augur AI: Chrome built-in Gemini Nano chat in the nav, cross-tab synced via `chrome.storage.session`, 30-min idle clear · 顶栏内置 Gemini Nano 对话，跨标签同步 + 30 分钟自动清空

🚧 next ideas · 后续

- Last-3-domain sequence features (RNN-lite) · 序列特征
- Multi-objective bandit: dwell time vs click-through · 多目标 bandit
- Drag-to-reorder + custom non-domain non-window groups · 自定义分组
- Auto-snapshot daily workspace (opt-in) · 每日自动工作区快照
- Encrypted blob sync of model weights (events stay local) · 加密权重同步

---

## Docs · 文档

Deep-dive docs for each subsystem live in [`doc/`](./doc/). · 各子系统的详细文档在 [`doc/`](./doc/)。

| Doc | Topic |
|---|---|
| [doc/DESIGN.md](./doc/DESIGN.md) | Visual identity, theme tokens, component-level UX decisions |
| [doc/ARCHITECTURE.md](./doc/ARCHITECTURE.md) | SW / dashboard / RPC split, build pipeline |
| [doc/ML.md](./doc/ML.md) | Online LR + Adam + L1, Platt calibration, bandit, embeddings, smart-cleanup feedback loop |
| [doc/STORAGE.md](./doc/STORAGE.md) | Dexie schema, KV keys, chrome.storage usage rules, update preservation |
| [doc/PRIVACY.md](./doc/PRIVACY.md) | What's collected, where it lives, what leaves the browser, wipe procedure |
| [doc/API.md](./doc/API.md) | Typed RPC reference — every `RpcRequest` / `RpcResponse` variant |
| [doc/CONTRIBUTING.md](./doc/CONTRIBUTING.md) | Dev workflow, code conventions, how to add a feature / RPC / ML feature |

---

## Contributing · 贡献

PRs welcome. The codebase is structured around three boundaries: · 欢迎 PR。代码三道边界：

- **`ml/`** — all model & training logic. Self-contained, pure functions where possible. · 所有模型与训练逻辑，尽量纯函数。
- **`background/`** — service worker, RPC, event collection. · service worker、RPC、事件采集。
- **`dashboard/`** — UI only. Talks to `background/` via the typed `RpcRequest` union. · 纯 UI，通过类型化 RPC 信封跟 `background/` 对话。

Read the [Architecture](#architecture--架构) section before sending non-trivial PRs. The model is the heart of the product — changes there should come with a quick justification of how the new feature integrates with the existing pipeline. · 提非平凡 PR 前请读架构章节。模型是产品核心——新特征要附一句"如何接入现有管线"的说明。

Style: TypeScript strict, no `any`, no `console.log` in committed code, prefer composition over inheritance, prefer explicit RPC types over loose `unknown`. · 风格：TS strict、不用 any / console.log、组合优于继承、RPC 全类型化。

---

## License · 许可证

[MIT](./LICENSE) · MIT 协议
