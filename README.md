# chromehomepage

A learning new-tab dashboard that recommends what to open and flags what to close. · 一个会学习的新标签页仪表板，推荐你接下来要打开的、以及该清理掉的。

Everything runs on-device — no telemetry, no cloud sync, no model weights leaving the browser. · 全部在本地运行——没有遥测、没有云同步、模型权重永不离开浏览器。

---

## Features · 功能

- **Smart new-tab page.** Replaces the new-tab page with a Material Design 3 dashboard. · **智能新标签页。** 用 Material Design 3 仪表板替换新标签页。
- **Tab management.** Group open tabs **by domain or by window** (toggle), multi-select, batch close or stash, fuzzy search, jump-to-tab. · **标签管理。** **按域名或按窗口分组**（可切换）、多选、批量关闭或暂存、模糊搜索、点击直达。
- **Full keyboard control of the tab grid.** Arrow keys move focus, Space toggles selection, Enter switches to the tab, Delete closes it, ⌘A selects all. · **标签网格全键盘可控。** 方向键移动焦点、Space 选中、Enter 切换、Delete 关闭、⌘A 全选。
- **Workspaces.** Save the current set of tabs as a named workspace, restore in the same window or a new one. Rename, update from current, or delete from a tap menu. · **工作区。** 把当前标签集保存为命名工作区，在当前窗口或新窗口恢复；右上角菜单可重命名、覆盖更新、删除。
- **Today's recap.** Glanceable strip below the greeting: tabs opened today, domains visited, focus minutes, top domain, busiest hour. Hides until there's data. · **今日总览。** 问候语下的一条信息：今天打开的标签、访问域名、专注分钟、Top 域名、最忙时段；没数据时自动隐藏。
- **Tab stash.** Park tabs in a stash pane instead of closing — single click to restore. Stash buttons in the tab wall and in cleanup cards. · **标签暂存。** 不直接关，先放进暂存区，一键恢复。标签墙和清理卡片里都有暂存按钮。
- **Open recommendations (Head A).** Predicts your next site from frecency, time-of-day, day-of-week, recency, co-occurrence with the focused tab, and skip-gram embedding similarity. · **打开推荐（Head A）。** 根据衰减频次、时段、星期、最近性、与当前标签的共现，以及 skip-gram 嵌入相似度预测你接下来要去的站点。
- **Cleanup recommendations (Head B).** Predicts which open tabs you'll never refocus, with explicit accept / stash / dismiss / snooze actions. Implicit positive labels every time you close a stale tab. · **清理推荐（Head B）。** 预测哪些标签你不会再回来；四键反馈（关掉 / 暂存 / 保留 / 稍后），再加每次主动关闭的隐式正样本。
- **Skip-gram domain embeddings.** 32-dim vectors trained from co-occurrence; injected as a feature in both heads, retrained every 12 h. · **Skip-gram 域名嵌入。** 32 维向量，从共现表训练，作为两个头的特征接入，每 12 小时重训。
- **Activity insights.** Heatmap of focus time by day × hour, top domains by focus time. · **活动洞察。** 按"星期 × 小时"画专注热力图，按专注时长排名域名。
- **Onboarding + learning progress.** First-run modal explains what's collected and shows a live "X / 50 events" progress bar; empty states surface the same. · **引导 + 学习进度。** 首次启动告诉你"在收集什么"并展示实时进度条；空态也展示同样的进度。
- **Settings (3 tabs): General · Data · Advanced.** Theme cycle, language; data summary + JSON export + full wipe; **model debug panel** with LR coefficients, bandit α/β, embedding stats and nearest neighbors. · **设置三个标签：通用 · 数据 · 高级。** 主题循环与语言；数据汇总 + JSON 导出 + 整体清除；**模型调试面板**（LR 系数、bandit α/β、嵌入统计与最近邻）。
- **Command palette (⌘K).** Unified search across open tabs, history, bookmarks, and commands, with arrow-key navigation. · **命令面板（⌘K）。** 跨"打开标签 / 历史 / 书签 / 命令"的统一搜索，方向键导航。
- **i18n.** English + Simplified Chinese, auto-detected, switchable from the header. · **国际化。** 内置中英双语，自动跟随浏览器语言，顶栏可切换。

---

## Architecture · 架构

```
┌─ Service Worker (background) ────────────┐    ┌─ Dashboard (new tab) ──────┐
│                                          │    │                            │
│  chrome.tabs / windows / idle events     │    │  React + MUI v6 (MD3)      │
│            │                             │    │  i18next (en / zh)         │
│            ▼                             │    │  ┌──────────────────┐      │
│      event logger ──► IndexedDB (Dexie)  │    │  │  Suggestions     │      │
│            │                             │    │  │  TabWall         │      │
│            ▼                             │    │  │  Cleanup         │      │
│      aggregator (domain stats, co-occur) │    │  │  Insights        │      │
│            │                             │    │  └────────┬─────────┘      │
│            ▼                             │    │           │ chrome.runtime │
│   ┌──── Head A: open recommender ─────┐  │    │           ▼                │
│   │   features → LogReg → bandit      │◀─┼────┤    callRpc(...)            │
│   └───────────────────────────────────┘  │    │                            │
│   ┌──── Head B: cleanup recommender ──┐  │    │                            │
│   │   features → LogReg → bandit      │◀─┼────┤    feedback events ─────►  │
│   └───────────────────────────────────┘  │    │                            │
└──────────────────────────────────────────┘    └────────────────────────────┘
```

### Data layer · 数据层 — `src/shared/`, `src/ml/aggregate.ts`

Five IndexedDB tables (Dexie). · 五张 IndexedDB 表（用 Dexie）。

| Table · 表        | Purpose · 用途                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `events`          | Append-only log of every tab event (open / focus / blur / close / navigate / idle). · 所有标签事件的追加日志。 |
| `domains`         | Per-domain rolling stats: decayed visits, focus time, hour/day histograms, quick-close rate. · 每域名的滚动统计：衰减访问、专注时长、时段直方图、快速关闭率。 |
| `cooccurrence`    | Pair counts for domains opened within a 5-minute window. · 5 分钟窗口内成对打开的域名计数。                    |
| `feedback`        | Every accept / dismiss / snooze the user issued on a recommendation. · 用户对推荐的"关掉/保留/稍后"反馈。       |
| `kv`              | Misc state: model weights, bandit posteriors, last-aggregate timestamp. · 杂项：模型权重、bandit 后验、上次聚合时间。 |

Aggregation runs incrementally on every event (cheap path) plus a batch decay pass every 6 hours via `chrome.alarms`. · 每个事件触发一次增量聚合；另由 `chrome.alarms` 每 6 小时跑一次批量衰减。

Decay constants: τ = 14 d for visits, τ = 30 d for co-occurrence, with `exp(-Δt/τ)`. · 衰减常数：访问 τ=14 天，共现 τ=30 天，公式 `exp(-Δt/τ)`。

### Recommender · 推荐系统 — `src/ml/`

Two heads, both online-learned, both run in the service worker. · 两个头，均为在线学习，全部跑在 service worker 内。

#### Head B — cleanup · 清理（哪个开着的标签可以关）

```
features (14-d)              online learner             policy
──────────────                ──────────────             ──────
tabAgeMs                  ┐                          ┌─ Beta(α, β) per
timeSinceFocusMs          │   OnlineLogReg           │  (domain, reason)
focusMs / focusCount      │   ─ Welford z-score      │  ↳ Thompson sample
focusRate                 │   ─ SGD with L2          │  ↳ multiply by p
isPinned / isGrouped      │── ─ priorRate=0.15       │
domainVisitsDecay         │                          ├─ accept  → α += 1
domainAvgFocusMs          │                          ├─ dismiss → β += 1
sameDomainOpenCount       │   p = sigmoid(w·x + b)   ├─ snooze  → β += 0.5
domainCloseQuickRate      │                          └─ ignore  → β += 0.25
domainCloseWithoutFocus   │
embedSimToOpen            │   (mean cosine of this domain to the
                          │    domains of currently engaged tabs)
hour / dow                ┘
```

Rank by `score = p × (0.5 + sample(Beta(α, β)))`, threshold at 0.55, top 5. · 排序方式：`score = p × (0.5 + Beta(α,β) 采样)`，阈值 0.55，取 Top 5。

The bandit is what makes "user keeps ignoring this kind of suggestion" turn into "stop suggesting it" — no hand-coded rules. · Bandit 让"用户连续忽略某类建议→不再推荐"成为模型自然结果，不写任何 if/else。

#### Head A — open recommendation · 打开推荐（下一个站点是什么）

Candidate generation: top-80 by decayed frecency (no ANN — at per-user scale, brute force is cheaper than FAISS). · 候选生成：按衰减频次取前 80（用户级数据量小，暴力打分比 FAISS 还快）。

```
features (9-d)
──────────────
freqDecay                 (Σ exp(-(t−tᵢ)/τ))
avgFocusMs
hourMatch                 (softmax of stats.hourDist)[currentHour]
dowMatch                  (softmax of stats.dowDist)[currentDow]
recencyHours
cooccurrenceWithFocused
embedSimToFocused         (cosine in skip-gram embedding space)
isCurrentlyOpen           (filtered out · 已开的过滤掉)
isPinnedSomewhere
```

Reranked by the same `OnlineLogReg + BetaBandit` combo. Top 5 surfaced. · 用同一套 `OnlineLogReg + BetaBandit` 重排，输出 Top 5。

#### Domain embeddings · 域名嵌入

Skip-gram with negative sampling, trained directly on the `cooccurrence` aggregate (the pair-counts already encode "these two domains were opened in the same 5-minute window"). · Skip-gram + 负采样，直接基于 `cooccurrence` 聚合表训练（成对计数本身就编码了"这两个域名在同一个 5 分钟窗口里被打开"）。

- 32-dim vectors, two-tower style (separate input + context vectors). · 32 维，input/context 双向量。
- Marsaglia-Tsang negatives (5 per positive), lr 0.025, subsample very high-frequency pairs. · 5 个负样本/正样本，学习率 0.025，对超高频对做 subsampling。
- Retrained every 12 hours via `chrome.alarms`, capped at 8000 SGD steps per run to fit a service-worker compute budget. · 每 12 小时由 `chrome.alarms` 重训一次，每次最多 8000 步以适配 service worker 的 CPU 预算。
- Cosine similarity is fed into both heads as `embedSimToFocused` (Head A) and `embedSimToOpen` (Head B). · 余弦相似度作为 `embedSimToFocused`（Head A）和 `embedSimToOpen`（Head B）注入两个头。
- Inspectable in **Settings → Advanced**: vocab size, training steps, last-trained time, and live nearest-neighbor preview for top domains. · 在 **设置 → 高级** 里可查看：词表规模、训练步数、上次训练时间，以及 Top 域名的最近邻预览。

#### Why logistic regression instead of a neural net · 为什么是逻辑回归而不是神经网络

- Per-user data volume is hundreds-to-thousands of labels, not millions. · 每位用户只有几百到几千条标签，不是百万级。
- A 15-feature LR with z-score standardization beats an MLP at this scale while training in microseconds; embeddings come in as a single distilled feature rather than as a learned tower. · 15 维 LR + z-score 在这个规模上比 MLP 还准，训练只要几微秒；嵌入以一个蒸馏后的特征注入，而不是作为单独的塔参与训练。
- Manifest V3 service workers go idle every ~30 s; tiny models survive sleep cycles. · MV3 service worker 每 30 秒就睡，小模型才能扛住睡醒循环。
- Weights are < 1 KB, fit in `chrome.storage` easily. · 权重 < 1KB，放 `chrome.storage` 毫无压力。
- Coefficients are inspectable for debugging — important for a personal tool. · 系数可读，调试方便——对个人工具很重要。

#### Sources of labels · 标签来源

Explicit (high weight) · 显式（高权重）：

- Cleanup card → **Close** → positive cleanup label, bandit α += 1. · 清理卡片→**关掉**→正样本，α += 1。
- Cleanup card → **Keep** → negative cleanup label, bandit β += 1. · 清理卡片→**保留**→负样本，β += 1。
- Cleanup card → **Snooze** → 0.5-weighted negative. · 清理卡片→**稍后**→0.5 权重负样本。
- Suggestion clicked → positive open label. · 推荐被点击→打开正样本。
- Suggestion dismissed → negative open label. · 推荐被忽略→打开负样本。

Implicit (low weight) · 隐式（低权重）：

- Any new domain opened → soft positive label for the open recommender at that hour-of-day / day-of-week context. · 任何新域名打开→在该时段上下文里给打开推荐器加一条软正样本。

### Service-worker lifecycle · service worker 生命周期 — `src/background/`

- All listeners registered at top level — Manifest V3 service workers go to sleep, and only top-level listeners survive wake-up. · 所有监听器在顶层注册——MV3 service worker 会睡，只有顶层监听器能在唤醒后存活。
- Per-tab runtime state (focus segments, accumulated focus time) stored in `chrome.storage.session` so it survives SW sleep but resets on browser restart. · 每标签的运行时状态（聚焦段、累计专注时长）存在 `chrome.storage.session`，能扛 SW 睡眠，浏览器重启时清空。
- `chrome.idle.onStateChanged` pauses focus accounting when the user is away from the keyboard for > 60 s. · 用户离开键盘超过 60 秒时，`chrome.idle.onStateChanged` 暂停专注计时。
- `chrome.alarms` heartbeat (5 min) keeps short writes alive; nightly-decay alarm (6 h) rolls visit decay forward. · `chrome.alarms` 每 5 分钟心跳一次保住短写；每 6 小时跑一次衰减。

### Privacy · 隐私

- **Zero network calls by design.** The only outbound HTTP requests are to `https://www.google.com/s2/favicons?…` for sites you already visit. · **设计上零网络调用。** 唯一的对外请求是抓你已经访问过的站点的 favicon。
- All events, model weights, bandit posteriors, and aggregates live in IndexedDB (`chromehomepage` database). · 所有事件、模型权重、bandit 后验、聚合数据都在 IndexedDB（`chromehomepage` 数据库）里。
- No analytics, no error reporting, no remote config. · 没有埋点、没有错误上报、没有远端配置。

---

## Tech stack · 技术栈

| Layer · 层      | Choice · 选型                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| Build · 构建    | Vite + `@crxjs/vite-plugin` (Manifest V3)                                                                    |
| Language · 语言 | TypeScript (strict)                                                                                          |
| UI              | React 18 + MUI v6, Material Design 3 token theme · React 18 + MUI v6，MD3 token 主题                         |
| Font · 字体     | Roboto Flex (`@fontsource/roboto-flex`)                                                                      |
| Persistence · 持久化 | Local component state + Dexie (IndexedDB) · 本地组件状态 + Dexie（IndexedDB）                            |
| i18n            | `chrome.i18n` for manifest, `i18next` for the dashboard. · manifest 用 `chrome.i18n`，仪表板用 `i18next`。   |
| ML              | Hand-rolled online LR, Welford normalization, Beta–Bernoulli Thompson sampling. · 自写的在线 LR、Welford 归一、Beta-Bernoulli Thompson 采样。 |
| RPC             | `chrome.runtime.sendMessage` with a typed `RpcRequest` union. · 用 `chrome.runtime.sendMessage` + 类型化 RPC 信封。 |

No TF.js, no ONNX, no chart library. Everything is < 1 MB and runs in a service worker without warming up a tensor backend. · 没有 TF.js、ONNX、图表库。整体 < 1MB，在 service worker 里跑也不用热身张量后端。

---

## Project structure · 项目结构

```
src/
├── manifest.ts                     # MV3 manifest (consumed by @crxjs)
├── shared/
│   ├── db.ts                       # Dexie schema · Dexie 数据库定义
│   ├── types.ts                    # cross-boundary types · 跨边界共享类型
│   └── rpc.ts                      # typed RPC envelope · 类型化 RPC 信封
├── background/
│   ├── index.ts                    # SW entry · service worker 入口
│   ├── messaging.ts                # RPC dispatch · RPC 分发
│   └── state.ts                    # session storage helpers · 会话存储工具
├── ml/
│   ├── aggregate.ts                # incremental + batch aggregation · 增量与批量聚合
│   ├── features.ts                 # feature extraction · 特征抽取
│   ├── cleanup.ts                  # Head B · 清理头
│   ├── recommend.ts                # Head A · 打开推荐头
│   ├── insights.ts                 # heatmap, top domains · 热力图与域名榜
│   ├── persistence.ts              # model + bandit state · 模型/bandit 状态持久化
│   ├── math.ts                     # sigmoid, sampleBeta, Welford, softmax
│   └── models/
│       ├── logreg.ts               # OnlineLogReg
│       └── bandit.ts               # BetaBandit
└── dashboard/
    ├── index.html
    ├── main.tsx                    # CssVarsProvider + theme + i18n
    ├── theme.ts                    # MD3 tokens · MD3 主题
    ├── styles.css
    ├── App.tsx                     # composition · 整体布局
    ├── api/recommendations.ts      # SW RPC client · SW 调用封装
    ├── components/
    │   ├── AppHeader.tsx           # MD3 app bar · MD3 顶栏
    │   ├── Greeting.tsx            # time-aware salutation · 时段问候
    │   ├── SearchBar.tsx           # MD3 hero search · 主搜索条
    │   ├── Suggestions.tsx         # smart suggestions · 智能推荐
    │   ├── TabWall.tsx             # tabs grouped by domain · 域名分组的标签墙
    │   ├── CleanupSuggestions.tsx  # accept / dismiss / snooze · 关掉/保留/稍后
    │   └── Insights.tsx            # heatmap + top-domain bars · 热力图 + 域名条
    ├── hooks/useTabs.ts
    └── i18n/{index.ts,en.json,zh.json}
public/_locales/{en,zh_CN}/messages.json   # manifest-level strings · manifest 级文案
```

---

## Install (developer mode) · 安装（开发者模式）

```bash
npm install
npm run build
```

Then in Chrome · 然后在 Chrome 里：

1. Open `chrome://extensions`. · 打开 `chrome://extensions`。
2. Toggle **Developer mode** (top right). · 右上角打开 **开发者模式**。
3. Click **Load unpacked** and pick `dist/`. · 点 **加载已解压的扩展程序**，选 `dist/`。
4. Open a new tab — you should see the dashboard. · 新建标签页，看到仪表板就成功。

To make it your real homepage too · 要让它同时作为浏览器首页：

1. `chrome://settings/onStartup` → **Open a specific page or set of pages** → add `chrome-extension://<your-extension-id>/src/dashboard/index.html`. · `chrome://settings/onStartup` → **打开特定网页或一组网页** → 添加 `chrome-extension://<扩展 ID>/src/dashboard/index.html`。
2. (Optional) `chrome://settings/?search=home+button` → enable home button → set the same URL. · （可选）`chrome://settings/?search=home+button` → 启用主页按钮 → 同一 URL。

The extension ID appears under the extension card in `chrome://extensions`. · 扩展 ID 在 `chrome://extensions` 的扩展卡片上能看到。

### Development · 开发

```bash
npm run dev          # Vite + CRX hot-reload · 热加载
npm run typecheck    # tsc -b --noEmit
npm run build        # production bundle in dist/ · 生产包
npm run icons        # regenerate PNGs from public/icons/icon.svg · 重新生成图标
npm run package      # build + zip dist into chromehomepage-<version>.zip · 构建并打包
```

`npm run dev` rebuilds on file save and reloads the dashboard automatically; service-worker changes require clicking the reload icon on the extension card. · `npm run dev` 会保存即编译并自动刷新仪表板；service worker 改动需要在扩展卡片上点刷新图标。

---

## Debugging · 调试

The dashboard is a normal extension page; the service worker is the part that's harder to inspect. Both are reachable from `chrome://extensions`. · 仪表板就是一个普通扩展页面；service worker 才是难以观察的部分。两者都可以从 `chrome://extensions` 进入。

### Service worker · 后台

1. Open `chrome://extensions`. · 打开 `chrome://extensions`。
2. Find the **chromehomepage** card and click **service worker** (the blue link). · 找到 **chromehomepage** 卡片，点击蓝色的 **service worker** 链接。
3. DevTools opens scoped to the SW — Console for `console.log`, Sources for breakpoints, Network for any outbound calls (there should be **none** by design except favicons). · 会打开 DevTools 并切到 SW 上下文：Console 看 log、Sources 下断点、Network 看对外请求（**默认应该只有 favicon 一类**）。
4. The SW sleeps after ~30 s of inactivity. Trigger any tab event (open/close/focus) to wake it; or click **service worker** again to keep it warm. · SW 闲置约 30 秒后会睡。打开/关闭/切换任意标签即可唤醒；或者再点一次 **service worker** 让它保持活跃。

### Dashboard · 仪表板

Right-click anywhere on the new tab page → **Inspect**. The dashboard is just React; standard DevTools apply. · 在新标签页任意位置右键 → **检查**。仪表板就是普通 React 应用，DevTools 一切正常。

### Inspecting stored data · 查看存储

DevTools (on either context) → **Application** → **IndexedDB** → **chromehomepage**. Five tables: `events`, `feedback`, `domains`, `cooccurrence`, `stash`, `workspaces`, `kv`. The `kv` table holds model weights, bandit posteriors, and embeddings. · DevTools（任一上下文）→ **Application** → **IndexedDB** → **chromehomepage**。可以看到所有表；`kv` 里存着模型权重、bandit 后验、embedding。

### Watching the model · 观察模型

**Settings → Advanced** has a live debug panel: · **设置 → 高级** 是模型实时调试面板：

- LR coefficient bars (sorted by magnitude, color-coded for sign). · LR 系数条（按绝对值排序，正负不同色）。
- Bias, total samples, positive samples per head. · 每个头的 bias、总样本、正样本数。
- Platt calibration `a / b / n` per head (A=1, B=0 is the identity). · 每个头的 Platt 校准 `a / b / n`（a=1、b=0 表示尚未生效）。
- Embedding stats (vocab, training steps, last update) and live nearest-neighbor preview for the top 3 domains. · 嵌入统计（词表、训练步数、上次更新）以及 Top-3 域名的最近邻预览。
- Bandit posteriors (top arms by impressions, with α/β tooltip and accept rate bar). · Bandit 后验（按曝光排序的 Top arms，附 α/β tooltip 和接受率条）。
- **Reset models** button (clears LR/bandit/embedding only — events stay). · **Reset models** 按钮（仅清空 LR/bandit/embedding，事件流保留）。
- **Retrain now** button (force a synchronous embedding pass). · **Retrain now** 按钮（强制跑一次嵌入训练）。

### Testing flows · 调试流程

| What to test · 测什么 | How · 怎么测 |
| --- | --- |
| Cold start · 冷启动 | Settings → Data → **Wipe all** (also resets onboarding). Reload the new tab. Should see Chrome topSites as suggestions. · 设置 → 数据 → **清除全部**（同时重置首次引导），刷新新标签页，应能看到 Chrome topSites 作为推荐。 |
| Cleanup model · 清理模型 | Open a junk tab, leave it idle ≥ 30 min while using others; cleanup card should appear. Accept / dismiss / snooze and watch bandit α/β move. · 打开个垃圾标签放着不管 ≥ 30 分钟，让别的标签活跃。清理卡片会出现。点接受/保留/稍后，观察 bandit α/β 变化。 |
| Calibration · 校准 | After ~50 explicit feedbacks per head, Advanced should show `a` drift away from 1.0 and `n > 30`. · 每个头积累约 50 条显式反馈后，Advanced 里 `a` 会偏离 1.0、`n > 30`。 |
| Embeddings · 嵌入 | Browse domains in groups (e.g., GitHub + Linear + Notion in same session). After 12 h alarm or **Retrain now**, neighbors of one should include the others. · 把若干域名一起用（GitHub + Linear + Notion 同会话）。等 12 小时闹钟或点 **Retrain now**，其中一个的最近邻里应该出现其他几个。 |
| Tab event capture · 事件采集 | Settings → Data → **Export JSON** and inspect the `events` array. · 设置 → 数据 → **导出 JSON**，检查 `events` 数组。 |
| RPC errors · RPC 错误 | Stop the SW from `chrome://serviceworker-internals` while a dashboard action runs. The toast should surface the error. · 在 dashboard 操作运行时从 `chrome://serviceworker-internals` 杀掉 SW，toast 会弹出错误信息。 |

### Common issues · 常见问题

- **"My recommendations look random."** Until ~50 events the model is still warming up — Suggestions / Cleanup show a learning-progress empty state with the current count. · **"推荐看着随机。"** 50 个事件以内模型还在预热——推荐区会显示带进度条的空态。
- **"Stash button is missing on a tab."** `chrome://*` and `chrome-extension://*` URLs aren't trackable, by design. · **"某些标签上没有 Stash 按钮。"** `chrome://*` 和 `chrome-extension://*` 是有意排除的。
- **"Toast spam after I cancelled an action."** Toasts are queued and shown one by one — the rapid sequence will play out, but new actions won't multiply them. · **"取消动作后 toast 还在弹。"** Toast 是排队展示的，序列会播完，但新动作不会叠加。

---

## Releasing · 发布

```bash
# 1. Bump versions in lockstep · 同步升版本号
#    Edit BOTH:
#      - package.json:version
#      - (no separate manifest version — it's defined in src/manifest.ts and picks up package.json)
#    Actually, check src/manifest.ts and bump there too if it has a hardcoded version.
#    更新 package.json 的 version 和 src/manifest.ts 的 version。

# 2. Build + sanity check · 构建并自检
npm run typecheck
npm run package          # writes chromehomepage-<version>.zip · 输出 zip 到仓库根

# 3. Smoke-test the artifact · 烟测产物
#    a. chrome://extensions → toggle Developer mode
#    b. Load unpacked → pick dist/
#    c. Open a new tab — dashboard should render
#    d. Settings → Data should show event count incrementing
#    e. Suggestions / TabWall / Cleanup / Stash / Workspaces all reachable

# 4. Chrome Web Store upload · 上传到 Chrome Web Store
#    https://chrome.google.com/webstore/devconsole
#    Required materials · 需要准备：
#    - The zip from step 2 · 第 2 步产出的 zip
#    - Privacy policy URL · 隐私政策 URL
#      (this extension makes zero network calls except favicons; the policy
#       can be very short — a single page covering "all data stays local").
#    - Description (en + zh_CN), tagline · 应用简介（中英）+ 副标题
#    - At least 1 screenshot 1280×800 or 640×400. Recommended: 5 screenshots
#      covering the dashboard, Suggestions, Cleanup with feedback, Workspaces,
#      and the Insights heatmap. · 至少 1 张 1280×800 或 640×400 截图，建议 5 张：
#      仪表板、Suggestions、清理反馈、Workspaces、Insights 热力图。
#    - Small (440×280) and large (920×680) marquee tiles · 应用商店瓦片图。
#    - Category: Productivity · 类别：生产力。
#    - Permissions justification · 权限说明（每个权限解释为何需要）。
```

`npm run package` is idempotent — runs `prebuild` (icon regen) → `tsc` → `vite build` → `zip dist/`. The zip excludes source maps and Vite's internal manifest, so it's exactly what you'd ship. · `npm run package` 是幂等的——会跑 `prebuild`（重新生成图标） → `tsc` → `vite build` → `zip dist/`。zip 排除了 source map 和 Vite 内部 manifest，正好就是要上架的产物。

### Release checklist · 发版自检表

- [ ] `npm run typecheck` passes · 类型检查通过
- [ ] `npm run package` produces a fresh zip · 打包产出新 zip
- [ ] Loaded the unpacked `dist/` and the new tab page renders correctly · 加载 unpacked 后新标签页正常渲染
- [ ] Settings → Data → Wipe → reload — onboarding shows, cold-start suggestions are topSites · 清除数据后首次引导出现，冷启动推荐是 topSites
- [ ] Bumped `package.json` version and `src/manifest.ts` version to match · package.json 和 manifest.ts 版本号同步
- [ ] Updated Roadmap section in README · 更新 README 路线图
- [ ] Tested in light mode AND dark mode · 浅色 + 深色模式都测过
- [ ] Tested in `en` AND `zh` locales · 中英两种语言都测过
- [ ] Tested with browser using the new icon (toolbar should show the squircle, not a puzzle piece) · 浏览器工具栏显示自定义图标而不是默认拼图

---

## Roadmap · 路线图

**M1 ✅ — scaffold + tab management · 脚手架与标签管理**
MV3 + Vite, MD3 dashboard, i18n (en/zh), event collection, batch close, domain-grouped tab wall. · MV3 + Vite、MD3 仪表板、中英双语、事件采集、批量关闭、按域名分组的标签墙。

**M2 ✅ — cleanup model + feedback loop · 清理模型与反馈回路**
Head B (online LR + Beta bandit), explicit accept/dismiss/snooze labels, implicit labels from close events. · Head B（在线 LR + Beta bandit）、显式三键反馈、来自关闭事件的隐式标签。

**M3 ✅ — open-recommendation model + insights · 打开推荐与洞察**
Head A (candidate gen + LR reranker + bandit), focus heatmap, top domains, daily focus minutes. · Head A（候选生成 + LR 重排 + bandit）、专注热力图、域名榜、按天专注分钟数。

**M4 ✅ — quality of life · 体验打磨**

- Onboarding modal: privacy promise + what's collected + learning progress widget. · 首次引导：隐私承诺、采集说明、学习进度。
- Settings dialog: theme (light/dark/system), language, data export to JSON, data wipe. · 设置面板：主题（浅色/深色/跟随系统）、语言、JSON 导出、数据清除。
- Theme toggle in header, three-state cycle (light → dark → system). · 顶栏主题切换，三态循环。
- Command palette (⌘K / Ctrl+K) — unified search across open tabs, history, bookmarks, and commands. · 命令面板（⌘K / Ctrl+K）——跨"打开标签 / 历史 / 书签 / 命令"的统一搜索。
- Page title capture from `chrome.tabs.onUpdated` so suggestion cards show real titles. · 通过 `chrome.tabs.onUpdated` 抓真实标题，让推荐卡片显示页面名而非域名。
- Implicit cleanup labels: every user-initiated close is fed back as a soft positive. · 隐式清理标签：每次用户主动关闭都作为软正样本反哺模型。
- Learning-progress empty states for both Suggestions and Cleanup sections. · 推荐与清理板块的空态都带学习进度条。

**M5 ✅ — fancier ML + transparency · 更强的模型 + 透明度**

- Skip-gram domain embeddings (32-dim) trained on co-occurrence pairs, retrained every 12 hours via `chrome.alarms`. Cosine similarity injected as a feature in both heads. · 32 维 skip-gram 域名嵌入，基于共现成对训练，每 12 小时由 `chrome.alarms` 重训练；余弦相似度作为新特征接入两个头。
- New "semantically-related" recommendation reason driven by embedding similarity. · 新的"语义相关"推荐理由，由嵌入相似度驱动。
- Model debug panel inside Settings → Advanced: live LR coefficients sorted by magnitude, bandit α/β per arm, embedding stats with nearest-neighbor preview, manual retrain button. · 设置 → 高级里的模型调试面板：按绝对值排序的 LR 系数、每个 arm 的 bandit α/β、嵌入维度/词表/步数与最近邻预览、手动重训按钮。

**M6 ✅ — Tab Stash · 标签暂存**

- New `stash` Dexie table with bilingual UI. · 新增 `stash` Dexie 表与双语 UI。
- Stash buttons in TabWall (per-tab, per-domain, multi-select bulk) and in CleanupSuggestions (one-click "stash for later" alongside Close / Keep / Snooze). · TabWall（单个 / 整域名 / 批量）和清理建议（关掉 / 保留 / 稍后 旁边的"暂存"按钮）都能暂存。
- Stash section auto-hides when empty; cards show source ("from cleanup" badge) and relative time. · 空时自动隐藏；卡片显示来源（"来自清理"徽章）和相对时间。

**M7 ✅ — workspaces, multi-window, recap, accessibility · 工作区、多窗口、总览、可访问性**

- Workspaces: save current set of tabs as named sessions, restore in current/new window, rename / update / delete. · 工作区：把当前标签集保存为命名会话，可在当前/新窗口恢复，能重命名 / 更新 / 删除。
- TabWall toggle between **by domain** and **by window** with deterministic per-window color stripes. · 标签墙在 **按域名** 与 **按窗口** 之间切换，每个窗口有确定性的颜色条。
- Today's recap widget under the greeting: tabs opened, domains, focus minutes, top domain, busiest hour. · 问候语下的今日总览：打开标签、域名、专注分钟、Top 域名、最忙时段。
- Full keyboard navigation in the tab grid (Arrow / Space / Enter / Delete / ⌘A). · 标签网格全键盘导航。

**M8 — next ideas · 后续想法**

- Sequence-level features (last-3-domain context). · 序列级特征（最近 3 个域名上下文）。
- Calibrated probability output (Platt scaling) so the score is a real probability. · Platt scaling 校准概率，让分数有可解释含义。
- Multi-objective bandit: balance dwell time vs click-through. · 多目标 bandit：平衡停留时长和点击率。
- Drag-to-reorder + custom (non-domain, non-window) tab groups. · 拖拽重排 + 自定义（非域名、非窗口）的标签分组。
- Pinned / starred sites for the Smart Suggestions row. · 智能推荐行的钉选/收藏。
- Optional encrypted blob sync of model weights (events stay local). · 可选的加密云同步（仅同步模型权重，事件流永远不出设备）。
- Auto-snapshot daily workspaces (opt-in). · 每日自动快照工作区（需用户开启）。

---

## License · 许可证

MIT — see [LICENSE](./LICENSE). · MIT 协议，详见 [LICENSE](./LICENSE)。
