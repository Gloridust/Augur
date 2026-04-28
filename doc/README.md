# Augur · Docs

Deep-dive documentation for Augur. The top-level [README](../README.md) is the marketing + getting-started page; the docs in this folder go further into specific subsystems. · 顶层 README 是介绍 + 上手；这里的文档逐个子系统讲透。

## Index

| File | What it covers · 内容 |
|---|---|
| [DESIGN.md](./DESIGN.md) | Visual identity, theme tokens, component-level UX decisions · 视觉、主题、组件级 UX |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Service worker / dashboard split, RPC boundary, build pipeline · SW/dashboard 分层、RPC、构建 |
| [ML.md](./ML.md) | Online LR + Adam + L1, Platt calibration, bandit, embeddings, smart-cleanup feedback loop · 全套模型管线 |
| [STORAGE.md](./STORAGE.md) | Dexie schema, KV keys, chrome.storage usage rules, update preservation · 持久化与更新保留 |
| [PRIVACY.md](./PRIVACY.md) | What's collected, where it lives, what leaves the browser, wipe procedure · 隐私全披露 |
| [API.md](./API.md) | Typed RPC reference — every `RpcRequest` / `RpcResponse` variant · RPC 全表 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Dev workflow, code conventions, how to add a feature / RPC / ML feature · 开发与扩展 |

## Conventions

- **English-first** for technical content. Section headings often bilingual to mirror the README voice.
- **File paths use `:line`** for navigation in the GitHub UI (e.g. `src/ml/cleanup.ts:104`).
- **No emoji** in doc bodies — they're reserved for the marketing README.
- **Append-only** for the index above. If you add a new doc, link it here too.

## Out of scope

- Per-release changelogs — see git log.
- Marketing copy / screenshots — those live in the top-level README.
- API keys / credentials — Augur has none. The whole point is local-first.
