# Releasing Augur to the Chrome Web Store · 上架 Chrome 应用商店

This document is the end-to-end walkthrough for cutting a Chrome Web Store (CWS) release. Read it once before your first submission and keep it open during.

本文档是 Augur 上架 Chrome 应用商店的完整流程。**首次提交前完整读一遍，提交过程中保持打开备查**。

> **TL;DR** · 简要流程
>
> 1. Bump version · 升版本号
> 2. Confirm the dev `key` is commented out in `src/manifest.ts` · 确认 `src/manifest.ts` 里的开发者 `key` 行已注释
> 3. `npm run release`
> 4. Upload `augur-v<version>-cws.zip` to the [Web Store Developer Console](https://chrome.google.com/webstore/devconsole) · 把生成的 zip 上传到[开发者后台](https://chrome.google.com/webstore/devconsole)
> 5. Paste the permission justifications from §7 below · 把下面 §7 的权限说明粘进表单对应字段

---

## 1. Two flavors of "packaging" · 两种打包模式

Augur has two distinct package commands. They produce different artifacts for different purposes — using the wrong one for a CWS submission will get the upload rejected.

Augur 有两个不同的打包命令，产物不一样，用错会被商店拒收。

| Command · 命令 | Output · 产物 | Purpose · 用途 | Dev `key` allowed · 开发者 key |
|---|---|---|---|
| `npm run package` | `augur-<version>.zip` | Local installs (`Load unpacked`), private distribution · 本地 unpacked 安装、私下分发 | ✓ Yes · 允许 |
| `npm run release` | `augur-v<version>-cws.zip` | Chrome Web Store submission · 商店上架 | ✗ Enforced · 强制不允许 |

The `release` script runs strict pre-flight checks (see [§3](#3-the-release-script--发布脚本)). If any check fails, the script aborts before building the zip — by design. CWS submissions are slow to roll back, so we'd rather fail at build time than at upload.

`release` 脚本会跑严格的预检查（详见 [§3](#3-the-release-script--发布脚本)）。任一项不过就直接 abort，连 zip 都不生成——商店审核回滚很慢，所以宁愿在打包阶段就 fail，也不要在上传阶段才发现问题。

---

## 2. Pre-release checklist · 发布前清单

Walk through this list before running `npm run release`. None of it is optional.

跑 `npm run release` 之前**逐项检查**，每一条都是必需的。

### 2.1 Sanity checks · 基础检查（~5 min）

- [ ] `git status` is clean (or you've consciously decided to ship uncommitted code) · git 工作树干净（除非你确认要发包含未提交代码的版本）
- [ ] You are on the branch you intend to ship from (typically `main`) · 在打算发布的分支上（通常是 `main`）
- [ ] `npm run typecheck` passes · `npm run typecheck` 全过
- [ ] Manually smoke-tested the latest build by reloading the extension in Chrome and doing at least: open a new tab, run a search, save a workspace, close one tab via cleanup card, open Settings → Data → check stats appear · 已经在 Chrome 里重新加载最新 build，亲手测试过：开新标签页、跑一次搜索、存一个工作区、用清理卡片关一个 tab、打开设置→数据看到统计数字

### 2.2 Version bump · 版本号升级

The Chrome Web Store enforces strict version ordering — each upload must have a higher version than the previous published one. CWS uses dotted-quad semantics (`MAJOR.MINOR.PATCH.BUILD`); we use the first three.

CWS 强制版本递增——每次上传必须比上次已发布版本高。CWS 用四段数字（`MAJOR.MINOR.PATCH.BUILD`），我们用前三段。

- [ ] Bump `version` in `package.json` (e.g. `0.1.0` → `0.1.1`) · 修改 `package.json` 的 `version`（如 `0.1.0` → `0.1.1`）
- [ ] `src/manifest.ts` reads version from `defineManifest({ version: '0.1.0' })` — **update the same string there**. The release script compares both and aborts if they drift. · `src/manifest.ts` 的 `defineManifest({ version: '0.1.0' })` 里的版本号**同步改成一致**，release 脚本会校验两边是否对齐，对不上直接 abort

Version conventions · 版本号策略：

| Change type · 变更类型 | Bump · 升 |
|---|---|
| Bug fix, no UI change · 仅修 bug，UI 不变 | PATCH (`0.1.0 → 0.1.1`) |
| New feature, backwards compatible · 加新功能，向后兼容 | MINOR (`0.1.1 → 0.2.0`) |
| Schema change, breaking, or major UI overhaul · 数据 schema 变更、breaking change、重大 UI 改版 | MAJOR (`0.2.0 → 1.0.0`) |

### 2.3 Remove the developer `key` · 移除开发者 key

> **This is the single most common reason CWS rejects an upload.**
> **这是 CWS 拒收最常见的原因。**

`src/manifest.ts` contains a commented placeholder for a developer `key` (generated via `npm run extension-key`). The key gives you a stable extension ID across local rebuilds — but **CWS provides its own production key on first upload** and rejects any package that tries to set its own.

`src/manifest.ts` 里有一个注释掉的 `key` 占位（通过 `npm run extension-key` 生成）。这个 key 让本地多次 rebuild 后扩展 ID 保持稳定——但 **CWS 首次上传时会下发自己的生产 key**，任何自带 key 的包都会被拒收。

- [ ] Open `src/manifest.ts` · 打开 `src/manifest.ts`
- [ ] Confirm the `key:` line is **commented out** (the file ships with it commented; only uncomment for local dev) · 确认 `key:` 那行**注释着**（默认状态。只有本地开发想固定 ID 时才取消注释）
- [ ] The release script enforces this — if `dist/manifest.json` contains a `key` field, it aborts. But check anyway. · release 脚本会强制检查——`dist/manifest.json` 里出现 `key` 字段就直接 abort。但还是自己手动看一下

### 2.4 i18n & locale strings · 国际化字符串

- [ ] `public/_locales/en/messages.json` exists and contains `extName` + `extDescription` · `public/_locales/en/messages.json` 存在，且包含 `extName` 和 `extDescription`
- [ ] `public/_locales/zh_CN/messages.json` mirrors the same keys · 中文 locale 文件镜像同样的 key
- [ ] If you added user-facing strings since the last release, both `src/dashboard/i18n/en.json` and `zh.json` have them · 上次发布之后加的任何用户可见字符串，en 和 zh 两份 i18n 都补齐

### 2.5 Privacy policy · 隐私政策

CWS requires a privacy policy URL for any extension that requests permissions touching user data. We request `tabs`, `history`, `topSites`, `sessions` — so a privacy policy is mandatory.

涉及用户数据的权限会触发 CWS 的隐私政策强制要求。我们申请了 `tabs`、`history`、`topSites`、`sessions`——所以**必须**提供一个隐私政策 URL。

- [ ] [`doc/PRIVACY.md`](PRIVACY.md) is up to date with anything you changed since the last release · 上次发布后改了什么，[`doc/PRIVACY.md`](PRIVACY.md) 同步
- [ ] The public-facing version is hosted somewhere reachable (GitHub Pages, your project site, etc.) — the URL goes into the CWS submission form · 把这份隐私政策托管到一个公网可访问的地址（GitHub Pages、项目主页等），URL 要填进提交表单

---

## 3. The release script · 发布脚本

```bash
npm run release
```

What it does, in order · 它依次做什么：

1. Wipes `dist/` · 清空 `dist/`
2. Runs `npm run build` (icons + `tsc -b` + `vite build`) · 跑 `npm run build`（重生成 icon、TS 编译、Vite 打包）
3. Strips `dist/demo/`, `dist/.vite/` · 删掉 `dist/demo/` 和 `dist/.vite/`
4. **Pre-flight checks** (aborts on first failure) · **预检查**（任一不过直接 abort）:
   - `dist/manifest.json` has no `key` field · manifest 不含 `key`
   - All four icon sizes (16/32/48/128) present in `dist/icons/` · 四个 icon 尺寸齐全
   - Service-worker loader present and non-empty · service worker 文件存在且非空
   - `package.json` and `manifest.json` versions match · 两边版本号一致
   - No `*.map`, `.DS_Store`, `.vite/`, or `demo/` files anywhere in `dist/` · 没有 source map、`.DS_Store`、Vite 中间产物、demo 截图等不该上线的文件
5. Warns if the git working tree is dirty (non-fatal) · git 工作树脏则**软警告**，不 abort
6. Packs `dist/` into `augur-v<version>-cws.zip` with strict exclusions · 把 `dist/` 打包成 `augur-v<version>-cws.zip`，严格排除
7. Prints a summary + the next-step checklist · 打印汇总和下一步指引

Expected output · 预期输出：

```
▶ Cleaning previous dist/
▶ Building production bundle
   [icons] wrote ...
   ✓ built in 2.3s
▶ Stripping non-shipping artifacts
   removed dist/demo/
▶ Pre-flight checks
   manifest has no developer `key` ✓
   all 4 icon sizes present ✓
   service worker loader present ✓
   version 0.1.0 ✓
   215 files, no forbidden patterns ✓
▶ Packing release zip

✓ Release zip ready: augur-v0.1.0-cws.zip (305.6 KB)

Next steps:
  1. Smoke-test:  Load Unpacked → dist/
  2. Upload:      https://chrome.google.com/webstore/devconsole
  3. Permission justifications: see doc/RELEASE.md
```

If any pre-flight fails, fix the underlying issue and re-run. The script is idempotent — running it twice in a row produces an identical zip.

任何一项不过就先修，再跑。脚本幂等——连跑两次产物完全一致。

---

## 4. Smoke-testing the release build · 烟测发布构建

Before uploading, **install the freshly-built `dist/` as an unpacked extension** and run through the smoke test:

上传**之前**，先把刚构建的 `dist/` 当作 unpacked 扩展加载，做完整烟测：

1. `chrome://extensions` → Developer mode → Load unpacked → select the `dist/` folder · `chrome://extensions` → 开"开发者模式" → 加载已解压扩展 → 选 `dist/` 目录
2. Verify the extension icon appears in the toolbar · 工具栏上能看到扩展图标
3. Open a new tab — Augur dashboard should load with no console errors (`⌘⌥I` → Console) · 开新标签页，dashboard 正常加载，控制台（`⌘⌥I`）没有红字报错
4. Open Settings → Data — stats should show non-zero values (assuming you've used the dev build) · 打开设置→数据，统计数字非零
5. Open the service-worker DevTools (`chrome://extensions` → "service worker" link under Augur's card) — no red errors · 打开 SW 的 DevTools（`chrome://extensions` → Augur 卡片的 "service worker" 链接）——没有红色错误
6. Trigger one action of each type: search, pin a shortcut, save a workspace, stash a tab, accept a cleanup suggestion. Confirm none throw · 把每类操作各做一遍：搜索、加置顶、存工作区、暂存 tab、接受清理建议。确认都不报错

If any of these fail, **do not upload**. Fix and rebuild.

任何一项失败，**不要上传**。修了再重打。

---

## 5. Chrome Web Store submission · 商店提交

### 5.1 First-time setup · 首次开通开发者账号

If this is the first time you've published an extension under this Google account:

如果是你这个 Google 账号第一次发扩展：

1. Visit https://chrome.google.com/webstore/devconsole · 访问开发者后台
2. Pay the one-time $5 developer registration fee · 缴一次性 $5 开发者注册费
3. Verify your identity per Google's requirements · 按 Google 要求完成身份验证

The developer account is per-Google-account. You can switch the account that owns the listing later, but it's a multi-step process — pick the right account up front.

开发者账号绑定 Google 账号。之后可以转移到另一个账号，但流程繁琐——一开始就选对账号。

### 5.2 New extension (first upload) · 新扩展（首次上传）

1. Developer Console → **"New item"** · 开发者后台 → **"新建项目"**
2. Upload `augur-v<version>-cws.zip` · 上传 zip
3. Wait for the upload to be processed (~30 seconds) · 等上传处理完（~30 秒）
4. Fill out the **Store listing** · 填**商店信息**：
   - Detailed description: see [§6](#6-store-listing-copy--商店描述文案) below · 描述文案见下面 [§6](#6-store-listing-copy--商店描述文案)
   - Category: **Productivity** · 分类：**生产力**
   - Language: English (primary); add Simplified Chinese as a secondary language with localized name/description · 主语言英文，再加简体中文作为副语言
   - Screenshots: at least one 1280×800 or 640×400. Five is the maximum and recommended. · 截图：至少 1 张，最多 5 张。1280×800 或 640×400
   - Small promo tile: 440×280 · 小宣传图：440×280
   - Marquee promo tile (optional but recommended): 1400×560 · 大横幅（可选但推荐）：1400×560
5. Fill out **Privacy practices** · 填**隐私实践**：
   - Single purpose: "A new-tab page that learns from your browsing patterns and surfaces what you'll need next." · 单一用途说明
   - For each permission you've requested, paste the matching justification from [§7](#7-permission-justifications--权限说明) · 每个权限粘 [§7](#7-permission-justifications--权限说明) 对应段落
   - Data usage: declare **none** — Augur does not collect, transmit, sell, or share user data · 数据用途：声明**不收集、不传输、不出售、不共享**
   - Privacy policy URL: paste your hosted URL · 粘隐私政策 URL
6. Distribution: **Public** (or "Unlisted" if you want to start private) · 发布范围：**公开**（或先 unlisted 内测）
7. Click **Submit for review** · 提交审核

Expected review time: **1 to 7 days** for first submission. Subsequent updates typically clear within 24 hours.

预期审核时长：首次提交 **1–7 天**。后续更新通常 24 小时内通过。

### 5.3 Update (subsequent uploads) · 更新（后续上传）

1. Developer Console → existing item → **Package** → **Upload new package** · 开发者后台 → 现有项目 → **程序包** → **上传新程序包**
2. Upload `augur-v<version>-cws.zip` (must have a higher version than the published one — the release script verifies this) · 上传新 zip，版本号必须高于已发布版本（release 脚本会校验）
3. The store listing fields are sticky — usually you only need to update **What's new in this version** · 商店描述字段是粘性的——通常只需要更新"本次更新内容"
4. Click **Submit for review** · 提交审核

---

## 6. Store listing copy · 商店描述文案

### 6.1 Short description (132 chars max) · 短描述（不超过 132 字符）

**English** (canonical):

```
A new-tab dashboard that learns your patterns and surfaces what you'll need next — entirely on-device, zero data uploaded.
```

**简体中文**（副语言）：

```
会学习的新标签页——基于你的浏览习惯预测你接下来要打开的页面。所有数据保留在本机，零上传。
```

### 6.2 Detailed description · 详细描述

**English** (paste into "English" tab of CWS):

```
Augur replaces Chrome's new-tab page with a learning dashboard that watches how you actually use your browser and surfaces what you'll need next.

▸ Smart tab cleanup — flags tabs you're about to abandon, learns from your accept/keep feedback.
▸ Workflow predictions — when the model is confident, a small capsule at the top of the new-tab page suggests what to open next based on recent context.
▸ Workspaces & pinned shortcuts — save tab sets you return to, with a pinned row that re-orders by time-of-day usage patterns.
▸ Today's stats — tabs opened, domains visited, focus time, busiest hour, all from your own browsing.

Privacy
─────────
Augur is 100% on-device. Every event, model weight, and saved item lives in your browser's IndexedDB. There is no cloud sync, no telemetry, no analytics. The only outbound HTTP request the extension makes is to fetch favicons from Google's public favicon endpoint for sites you've already visited.

Optional: Chrome's built-in Gemini Nano (on-device, no network) can be enabled in Settings for workspace name suggestions. Predictions and rankings are never AI-generated — they stay 100% deterministic and local.

Permissions
─────────
Each permission the extension requests is justified in the Chrome Web Store listing. In short: we observe tab events to learn patterns, read your top sites for cold-start, and use idle / alarms for background training. We never inject scripts, never read page content, never request network or host permissions.

Open source
─────────
Augur is MIT-licensed. Source, issue tracker, and release notes at: <YOUR_REPO_URL>
```

**简体中文**（粘到"简体中文"语言 tab）：

```
Augur 用一个会学习的仪表板替换 Chrome 新标签页 —— 它观察你真实的浏览习惯，预测你接下来需要什么。

▸ 智能标签清理 —— 自动识别你即将放弃的标签，根据你的「保留 / 关闭」反馈持续学习。
▸ 工作流预测 —— 模型确信时，在新标签页顶部弹出胶囊，基于最近上下文建议下一步要打开的页面。
▸ 工作区与置顶项 —— 保存常用标签组合；置顶行按时段习惯自动排序。
▸ 今日数据 —— 打开的标签数、域名、专注时长、最忙时段，全部来自你自己的浏览数据。

隐私
─────────
Augur 完全在本机运行。所有事件、模型权重、保存的内容都在浏览器的 IndexedDB 里。无云同步、无埋点、无遥测。唯一的对外网络请求是从 Google 公开 favicon 接口拉取你已经访问过的站点的图标。

可选：在设置中启用 Chrome 内置的 Gemini Nano（本地运行、不联网）来为工作区生成名称。**预测和排序永远不会由 AI 生成**——它们保持 100% 确定性、完全本地。

权限
─────────
扩展申请的每一项权限在商店页面都有说明。简单来说：观察标签事件来学习模式、读取常用站点用于冷启动、用 idle / alarms 做后台训练。**永远不注入脚本、不读取页面内容、不请求网络或 host 权限。**

开源
─────────
Augur 采用 MIT 协议。源码、问题追踪、发布说明：<YOUR_REPO_URL>
```

---

## 7. Permission justifications · 权限说明

CWS requires a justification for **each permission** beyond the default set. The Chrome Web Store form expects English text — paste the English block directly into the submission form. The Chinese paragraph that follows each is provided as a reference for what the English actually says.

CWS 对每一个非默认权限都要求一段说明。**Chrome 商店表单只接受英文**——把每节的英文段落直接粘到提交表单对应字段。其后的中文是辅助理解，**不用粘到表单里**。

### `tabs`

**English (paste into CWS):**

> Required to read URLs and titles of currently-open tabs so the user can see them in the Augur dashboard's tab list, search across them, and clean up stale ones. We also use `chrome.tabs.onCreated/onUpdated/onRemoved/onActivated` to learn the user's browsing patterns for on-device prediction. No tab content is ever read — only the URL, title, and Chrome-provided metadata (pinned/audible/discarded state).

**中文释义**：用于读取当前打开标签页的 URL 和标题，让用户在 Augur 的标签墙里看到、搜索、清理。同时通过 `chrome.tabs.*` 事件监听学习用户的浏览模式做本地预测。**永远不读取页面内容**——只用 Chrome API 暴露的 URL、标题、元数据（pinned/audible/discarded 状态）。

### `tabGroups`

**English (paste into CWS):**

> Required to read the user's tab group titles + colors so they appear correctly in the dashboard's tab list, and to learn which tabs the user has organized into named groups (a strong "keep this tab" signal for the cleanup model).

**中文释义**：用于读取用户的标签组标题和颜色，在 dashboard 里正确显示；同时学习用户把哪些标签放进了命名组（对清理模型来说是强"保留"信号）。

### `history`

**English (paste into CWS):**

> Required for one-time seeding of the on-device prediction model from the user's existing browser history on first install. Without this, the model would need weeks of live use to reach useful accuracy. The user can re-seed manually via Settings → Data → "Re-seed from browser history". History is never transmitted off-device.

**中文释义**：首次安装时一次性把浏览器历史导入 Augur 的本地事件日志，作为预测模型的冷启动数据。否则模型需要几周才能积累出有用的准确度。用户可在 设置→数据 里手动重新导入。**历史数据永远不离开本机。**

### `topSites`

**English (paste into CWS):**

> Required as a cold-start fallback: when the user has fewer than five domains in Augur's own event log, we pull their top sites to populate the initial recommendation pool. After enough live events accumulate, this fallback is no longer used.

**中文释义**：冷启动 fallback——当用户在 Augur 事件日志里的域名少于 5 个时，用 Chrome 自带的 top sites 列表填充初始推荐池。事件积累够之后就不再使用这条路径。

### `sessions`

**English (paste into CWS):**

> Required to detect tabs that survived a browser restart vs newly-opened tabs (the former is a "kept across sessions" signal the cleanup model uses; the latter resets engagement counters). Used as a read-only context source; we never call sessions.restore.

**中文释义**：区分"跨浏览器重启仍存在"的标签和"全新打开"的标签——前者对清理模型来说是强保留信号，后者会重置 engagement 计数。仅作只读上下文用，**永远不调用 sessions.restore**。

### `storage`

**English (paste into CWS):**

> Required for IndexedDB / chrome.storage.session to persist the user's events, model weights, saved workspaces, pinned shortcuts, and stashed tabs across browser restarts. All storage is local — there is no remote sync.

**中文释义**：用于 IndexedDB 和 `chrome.storage.session` 持久化用户的事件、模型权重、工作区、置顶项、暂存标签。**所有存储都是本地的**，无云同步。

### `alarms`

**English (paste into CWS):**

> Required to schedule background tasks: domain-statistics aggregation (every 6 hours), domain-embedding retraining (every 12 hours), and recommendation forest re-fitting (every 8 hours). These run in the service worker; they do not interact with the user or wake the device.

**中文释义**：用于在 service worker 里调度后台任务——域名统计聚合（每 6 小时）、域名嵌入重训（每 12 小时）、随机森林重新拟合（每 8 小时）。不会唤醒设备，也不与用户交互。

### `idle`

**English (paste into CWS):**

> Required to detect when the user is away from the keyboard. Used to (a) pause focus-time accumulation for the currently-focused tab and (b) feed the cleanup model an `isIdle` feature, since tabs left open while the user is away should not be punished the way tabs left open while the user is actively using something else are.

**中文释义**：检测用户是否离开键盘。用于（a）暂停当前 focused 标签的专注时长累计、（b）给清理模型喂一个 `isIdle` 特征——人不在的时候开着的 tab 不应该和"人在但晾着不看"的 tab 一样对待。

---

## 8. Screenshots & promotional tiles · 截图与营销瓦片

The CWS listing accepts up to 5 screenshots. Recommended set · CWS 商店页面最多 5 张截图，推荐：

1. **Hero shot** — dashboard with greeting, today recap, suggestions, open tabs visible · 主视图：问候、今日统计、智能推荐、打开的标签
2. **Smart cleanup** — InlineCleanupCard with 3 candidates + tooltip on the ✕ ("Keep") · 智能清理：清理建议卡片 + ✕ 的「保留」tooltip
3. **OracleHint** — Dynamic-Island capsule with 3 candidates (use a real screenshot, not a mock) · 灵动岛：3 候选的胶囊（**用真实截图，不要 mock**）
4. **Workspaces** — Save-workspace dialog or the workspace section · 工作区：保存对话框或工作区列表
5. **Settings → Data & Privacy** — showing local-only stats card and the export buttons · 设置→数据与隐私：突出"本地数据"和导出按钮

Dimensions: **1280×800** or **640×400**. PNG. No alpha channel. · 尺寸：**1280×800** 或 **640×400**，PNG，**不要透明通道**。

Marquee tiles (optional but recommended for discovery) · 营销瓦片（可选，但有助于商店推荐位曝光）：
- Small tile: **440×280** · 小瓦片：440×280
- Marquee tile: **1400×560** · 横幅：1400×560

Keep tile copy minimal — the wordmark + a one-liner is enough. Don't cram features in. · 瓦片文案越简洁越好：wordmark + 一行 slogan 就够，**不要堆砌功能**。

---

## 9. After approval · 通过审核后

When CWS approves · 审核通过后：

1. Check the public listing URL — try installing the public version side-by-side with your dev build (different Chrome profile is easiest) and verify behavior matches · 打开商店公开链接，用另一个 Chrome profile 装公开版本，和你的 dev build 并排比对行为
2. Tag the release in git · 在 git 里打 tag：
   ```bash
   git tag -a v<version> -m "Release <version>"
   git push origin v<version>
   ```
3. Attach the `augur-v<version>-cws.zip` to a GitHub Release for archival · 在 GitHub Releases 里挂上 zip 作为存档
4. Update the README's install instructions if needed (e.g. add a link to the CWS listing once it exists) · 如果之前 README 没写商店链接，现在可以加上
5. Watch the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) for the first few days — early install crashes / 1-star reviews surface there before users open issues · 上线后头几天盯紧开发者后台——早期崩溃和差评通常先出现在那里，比 GitHub issue 早

---

## 10. If CWS rejects · 被拒了怎么办

Common rejection reasons and fixes · 常见拒收原因与对应修复：

| Rejection reason · 拒收原因 | Fix · 修复 |
|---|---|
| "Manifest contains `key` field" · manifest 里有 `key` | Comment out `key:` in `src/manifest.ts`, rerun `npm run release` · 注释 `src/manifest.ts` 的 `key:` 那行，重跑 release |
| "Single purpose unclear" · 单一用途不清晰 | Re-read your description — does it describe one job? Cut any feature that doesn't serve the new-tab dashboard purpose · 检查描述文案是不是聚焦在"一件事"上，砍掉跟新标签页核心定位无关的功能描述 |
| "Permissions not justified" · 权限说明不充分 | Re-check [§7](#7-permission-justifications--权限说明); make sure every permission you list has a paragraph · 回 §7 对照，确认每个申请的权限都有对应段落 |
| "Privacy policy missing or insufficient" · 隐私政策缺失或不充分 | Host [`doc/PRIVACY.md`](PRIVACY.md) and link it; ensure it specifically addresses each permission · 把 [`PRIVACY.md`](PRIVACY.md) 托管到公网，确保它逐项覆盖你申请的权限 |
| "Misleading metadata" · 误导性元数据 | Don't mention competitors by name; don't claim AI capabilities you don't have · 别在描述里 cue 竞品名字；别夸大 AI 能力（你做了什么写什么） |
| "Uses remote code" · 包含远程代码 | Augur ships zero `<script src="https://...">` — if this fails it's a bug in our bundler config · Augur 本来就不含任何远程 script——如果触发了，说明 bundler 配置出了 bug |

Each rejection email includes a specific reason and a CWS reviewer contact. **Respond in the same thread** — don't open a new submission. Replies typically clear within 2-3 days.

每封拒收邮件都附具体原因和 reviewer 联系方式。**在同一封邮件里回复**，**不要重新提交**。回复后通常 2-3 天内有结果。

---

## Quick reference · 速查

```bash
# Pre-release · 发布前
npm run typecheck            # type errors must be zero · 类型错误必须为 0
# Bump version in package.json AND src/manifest.ts to match
# 同步升 package.json 和 src/manifest.ts 的版本号
# Verify src/manifest.ts has `key:` line commented out
# 确认 src/manifest.ts 里 `key:` 这行注释着

# Build the submission zip · 打包上架 zip
npm run release              # → augur-v<version>-cws.zip

# Smoke test · 烟测
# chrome://extensions → Load Unpacked → dist/
# Open new tab, run through key features
# 开新标签页，逐项试核心功能

# Submit · 提交
# https://chrome.google.com/webstore/devconsole
# Upload zip → paste permission justifications → submit
# 上传 zip → 粘 §7 的权限说明 → 提交审核
```
