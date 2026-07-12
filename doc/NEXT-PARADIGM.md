# Beyond ID-streams — the semantic paradigm (local-first)

> Status: **L1-lite + L2-lite SHIPPED in v8** (hashed text embeddings over
> tab titles/URLs — see `textembed.ts` / `domaintext.ts` and the
> `titleSimToFocused` / `titleSimToSession` features). **v9 (v0.4.2) added
> `dinAttention`** — an L3 *down-payment*: a DIN-style (Deep Interest
> Network, Alibaba KDD'18) target-attention feature that lets the candidate
> attend over the last 8 focused domains, parameter-free, reusing the
> skip-gram embeddings ([`attention.ts`](../src/ml/attention.ts)). It is a
> single feature inside the existing ensemble, not the learned two-tower
> backbone — that (L3-full), L2-full (pretrained sentence embeddings), L4
> (temporal point process), and L5 (task graph) remain **designed but NOT
> built** — they need assets and verification that don't exist in the dev
> environment. This document is the honest spec + status, not a claim of
> completion.

## The core insight

Until v8 the entire recommend stack treated browsing as a stream of **domain
IDs**: `github.com → x.com → localhost`, every (A→B) pair learned
independently. At ~300 domains that's ~90k pairs that ~16k events can't fill
— the sample-efficiency ceiling no amount of model tuning removes.

Real browsing has **semantic structure**: "I'm debugging Augur's auth" spans
a GitHub PR + localhost + the Claude docs + a Stack Overflow tab — one
*task*, not four unrelated IDs. A model that sees *meaning* generalizes from
one example ("Jira ticket about auth → GitHub PR about auth") to all
semantically-similar transitions. That is the paradigm shift: **from ID-flow
to meaning-flow.**

Hard constraint throughout: **local-first.** Every byte stays on device.

## The five layers

```
L5  Task graph        auto-discover "tasks"; predict task RESUMPTION
L4  Temporal point    predict WHEN you'll return, not just "is it relevant"
L3  Two-tower         learned representations become the backbone
L2  Semantic embed    every page → a vector from its text
L1  Richer signals    scroll depth / copy / dwell / nav-type (gated opt-in)
```

### L1 — richer signals · *partially shipped*

What's collected today (no new permission): tab **title** + URL (we already
have these via `tabs`), dwell time, `openedFrom`, audible/discarded, group
membership. v8 already exploits the title/URL text (L2-lite below) and dwell
(engagement weighting).

**Not done:** `webNavigation` transition types, scroll depth, copy events,
download events. These need `<all_urls>` host permission (scary install
dialog) or content scripts, so they must be a **gated "deep understanding"
opt-in**, default off — extracting page text, embedding it, then *discarding
the text* (only the vector persists). Deliberately deferred: the title+URL
signal already carries most of the semantic value without the permission.

### L2 — semantic embeddings · *L2-lite shipped, L2-full deferred*

**Shipped (v8):** [`textembed.ts`](../src/ml/textembed.ts) — a hashing-trick
text embedder (word unigrams + char trigrams → 48-dim signed-hash vector,
L2-normalized). [`domaintext.ts`](../src/ml/domaintext.ts) keeps a running
per-domain mean vector. Two features (`titleSimToFocused`,
`titleSimToSession`) give the LR/forest genuine **text** similarity: two
domains never co-visited but whose pages share vocabulary ("invoice",
"pull request") now land near each other. No model file, no network, ~60 KB
persisted, microsecond inference.

**Deferred (L2-full):** a pretrained sentence model (model2vec / potion
class — 8-15 MB static embeddings, WASM, <1 ms/page) would be strictly
better than hashing (it knows "auth" ≈ "login", "repo" ≈ "repository";
hashing only catches literal shared tokens). **Blocked on:** (a) bundling /
first-run-downloading an actual model asset, (b) a WASM matmul runtime, (c)
CWS review of the larger bundle. This is a self-contained future PR — the
feature interface (`titleSim*`) already exists, so L2-full is a drop-in
replacement of the vectorizer, not a re-architecture.

### L3 — two-tower retrieval · *designed, not built*

Replace hand-crafted features as the BACKBONE with a learned bi-encoder:

- **query tower**: recent session (page vectors + behavior + time) →
  attention-pooled intent vector
- **candidate tower**: page/domain → vector in the same space
- score = dot product; train with sampled softmax (the v8 ranking objective
  already in `OnlineLogReg.updateGroup` is the same loss)

The existing 30 hand-crafted features become a *wide residual* branch (true
wide-&-deep). **Why deferred:** a two-tower net is only worth it on top of
L2-full embeddings (garbage-in otherwise), and it needs real backtest data
to prove it beats the current LR+RF+MLP ensemble. Building it blind violates
the promotion rule. The v8 `TinyMLP` (Phase 5) is the toe-in-the-water
version — a deep head over the existing features, off by default, that the
user can backtest-promote. **v9's `dinAttention`** ([`attention.ts`](../src/ml/attention.ts))
is a second down-payment: candidate-as-query attention (temperature 0.25,
recency prior 0.85) over the last 8 focused domains, reusing the skip-gram
embeddings — the query tower's attention pooling, distilled into one
parameter-free feature that ships today without the full learned backbone.

### L4 — temporal point process · *designed, not built*

Reframe the question. Today: "is X relevant **right now**?" (classification).
Better: "**when** will the user next want X?" (a discrete-time hazard model
per domain). "Will return in the next few minutes" = recommend now; "won't
return for days" = a cleanup candidate. **This unifies the recommend and
cleanup heads into one temporal model** — the single most elegant
restructuring available. Deferred because it's a ground-up retraining of
both heads and, again, needs backtest evidence before replacing two
heads that currently work.

### L5 — task graph · *designed, not built*

The product payoff. Cluster pages (by L2 vectors + co-visit) into persistent
**tasks**; name them with the on-device Gemini Nano (the opt-in
infrastructure already exists); predict task **resumption**. OracleHint
evolves from "guess one URL" to **"Resume *Augur auth debugging* — restore 4
tabs"** — from saving one click to saving a whole workflow restart. Depends
on L2-full + L4; it's the capstone, not a standalone.

## Honest status table

| Layer | Status | Blocker to finishing |
|---|---|---|
| L1 richer signals | Title/URL + dwell shipped; web-nav/scroll deferred | New host permission → gated opt-in UX |
| L2 semantic embed | **L2-lite shipped (hashing)** | L2-full needs a pretrained model asset + WASM runtime |
| L3 two-tower | TinyMLP toe-in (opt-in) + v9 `dinAttention` feature shipped; full learned tower deferred | Needs L2-full + backtest proof |
| L4 temporal/hazard | Designed | Ground-up dual-head retrain + backtest proof |
| L5 task graph | Designed | Depends on L2-full + L4 |

## Why not just build it all now

Two real reasons, not excuses:

1. **No verification data here.** The dev environment has no event log. The
   project's own prime directive — "no change ships without a backtest
   delta" — means L3/L4/L5 (which restructure the backbone) *cannot* be
   responsibly shipped without the user's real data to prove they don't
   regress. The eval/backtest harness built in v8 Phase 0 is exactly the
   gate they must pass.
2. **L2-full needs an external asset** (a pretrained embedding model) that
   can't be fabricated. The hashing embedder is the honest on-device
   substitute that needs nothing external, and it's shipped.

The pragmatic path: ship L1-lite + L2-lite now (done, v8), let real usage +
backtests accumulate, then promote the TinyMLP if it earns it, and tackle
L2-full → L3 → L4 → L5 as separate, individually-verified PRs.
