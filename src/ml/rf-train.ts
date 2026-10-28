// Batch trainers that learn from the event log: the RandomForest recommend
// head (nightly alarm), the implicit-training replay (warm-up after a model
// bump / the "replay" button) and the sequence-memory rebuild.
//
// All of them walk the log chronologically with POINT-IN-TIME state
// (./walk + ./pit) and build features with the one shared builder
// (./candidate-features): the features for an event at time t only ever see
// events strictly before t. Building them from the live tables instead — as
// these trainers used to — handed every positive its own visit (recency 0,
// "visited in the last 30 min", inflated frecency/velocity), a target leak.
//
// The forest doesn't touch the OnlineLogReg — both heads coexist and are
// ensembled at inference. The LR keeps absorbing fresh signal online between
// forest refits; the forest captures non-linear interactions.

import { db } from '../shared/db';
import type { TabEvent, TabRuntimeState } from '../shared/types';
import {
  buildCandidateFeatures,
  makeFeatureContext,
  type ModelBundle,
} from './candidate-features';
import { RECOMMEND_FEATURE_NAMES, vectorFromRecommend } from './features';
import {
  adoptSequenceMemory,
  adoptTransition,
  candidatePool,
  samplePoolNegatives,
  clearSequenceMemoryCache,
  liveModels,
  trainImplicitOpen,
} from './recommend';
import { outcomeFeatures, trainCleanupOutcome } from './cleanup';
import { discardDirty } from './flush';
import type { BetaBandit } from './models/bandit';
import { DomainSequenceMemory } from './models/markov';
import { RandomForest } from './models/randomforest';
import { saveRecommendForest, saveSequenceMemory } from './persistence';
import { PointInTimeAggregates } from './pit';
import { walkEvents } from './walk';

const NEGATIVE_SAMPLES = 6; // per forest positive, drawn from the serving pool
const POSITIVE_LOOKBACK_DAYS = 30;
const MAX_FOREST_POSITIVES = 600; // newest positives kept for the fit (runtime budget)
const SESSION_DEDUP_MS = 30 * 60 * 1000; // forest: ≤1 positive per (domain, 30 min)

// Engagement × openedFrom sample weight (Phase 1.3 + 1.4). `focusMs` is the
// dwell the user gave the opened tab afterward (forward-joined from its
// eventual close); `openedFrom` reflects intent. Clipped to [0.5, 2.0].
// (A label-quality weight, not a feature — looking forward is legitimate.)
function sampleWeight(focusMs: number, openedFrom: string | undefined): number {
  const engagement = Math.max(0.5, Math.min(2.0, Math.log1p(focusMs / 30_000)));
  const intent = openedFrom === 'direct' ? 1.2 : openedFrom === 'link' ? 0.8 : 1.0;
  return Math.max(0.5, Math.min(2.0, engagement * intent));
}

// Forward-join: for each open event, the dwell time on that tab is recorded
// on its eventual `close` event (focusMs).
function buildDwellIndex(events: TabEvent[]): Map<number, Array<{ ts: number; focusMs: number }>> {
  const idx = new Map<number, Array<{ ts: number; focusMs: number }>>();
  for (const e of events) {
    if (e.type !== 'close' || e.tabId === undefined) continue;
    const arr = idx.get(e.tabId) ?? [];
    arr.push({ ts: e.ts, focusMs: e.focusMs ?? 0 });
    idx.set(e.tabId, arr);
  }
  return idx; // events arrive chronologically, so each list is sorted
}

function dwellAfter(
  idx: Map<number, Array<{ ts: number; focusMs: number }>>,
  tabId: number | undefined,
  openTs: number,
): number {
  if (tabId === undefined) return 0;
  for (const rec of idx.get(tabId) ?? []) if (rec.ts >= openTs) return rec.focusMs;
  return 0;
}

// Models for a point-in-time walk: everything is rebuilt as of each point
// except the bandit (explicit feedback; today's unless the caller — the
// backtest — supplies one).
async function pitModels(pit: PointInTimeAggregates, bandit?: BetaBandit): Promise<ModelBundle> {
  return pit.models(bandit ?? (await liveModels()).bandit);
}

// ── Random forest ──────────────────────────────────────────────────────
// For every switch-open in the last 30 days before `endTs`: one positive
// (the opened domain) + NEGATIVE_SAMPLES negatives drawn from the candidate
// pool serving would have ranked at that moment, features built
// point-in-time.
export async function trainRecommendForest(
  // endTs: train only on events before this instant (the backtest uses the
  // split point so the forest never sees test-period events).
  // persist=false: return the forest without overwriting the live one.
  // bandit: the bandit to build features with (default: the live one).
  opts: { endTs?: number; persist?: boolean; bandit?: BetaBandit } = {},
): Promise<{
  trained: number;
  posSamples: number;
  negSamples: number;
  forest?: RandomForest;
}> {
  const persist = opts.persist ?? true;
  // Full history before endTs: cumulative aggregates (visit counts, hour
  // histograms) need everything, not just the window.
  const events = await db.events.where('ts').below(opts.endTs ?? Infinity).toArray();
  if (events.length === 0) return { trained: 0, posSamples: 0, negSamples: 0 };
  // The lookback is anchored to the newest event, not the wall clock: after
  // a month away (or on an imported backup) "the last 30 days" of wall time
  // holds no events and the forest would silently train on nothing.
  const windowStart = events[events.length - 1].ts - POSITIVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  const pit = new PointInTimeAggregates();
  const models = await pitModels(pit, opts.bandit);
  const dwellIdx = buildDwellIndex(events);
  const lastPositiveTs = new Map<string, number>();
  const groups: Array<{ x: number[][]; w: number }> = [];

  await walkEvents(events, pit, async (e, point) => {
    if (!point || e.ts < windowStart) return;
    const domain = e.domain!;
    const lastPos = lastPositiveTs.get(domain);
    if (lastPos !== undefined && e.ts - lastPos < SESSION_DEDUP_MS) return;
    lastPositiveTs.set(domain, e.ts);

    const src = pit.source(e.ts);
    const fc = makeFeatureContext(
      {
        ts: e.ts,
        hour: e.hourOfDay,
        dow: e.dayOfWeek,
        focusHistory: point.focusHistory,
        focusedDomain: point.focusedDomain,
        openDomains: point.openDomains,
        sessionStartTs: point.sessionStartTs,
      },
      models,
    );
    const { pool } = await candidatePool(fc, src, models, { evaluation: true });
    const negs = samplePoolNegatives(pool, domain, NEGATIVE_SAMPLES);
    if (negs.length === 0) return;
    const x: number[][] = [];
    for (const d of [domain, ...negs]) {
      x.push(vectorFromRecommend(await buildCandidateFeatures(fc, d, src, models)));
    }
    groups.push({ x, w: sampleWeight(dwellAfter(dwellIdx, e.tabId, e.ts), e.openedFrom) });
  });

  const kept = groups.slice(-MAX_FOREST_POSITIVES);
  const X: number[][] = [];
  const y: number[] = [];
  const W: number[] = [];
  for (const g of kept) {
    g.x.forEach((row, i) => {
      X.push(row);
      y.push(i === 0 ? 1 : 0);
      W.push(i === 0 ? g.w : 1.0); // negatives unweighted
    });
  }
  const positives = kept.length;
  const negatives = X.length - positives;
  if (X.length < 20 || X[0].length !== RECOMMEND_FEATURE_NAMES.length) {
    return { trained: 0, posSamples: positives, negSamples: negatives };
  }

  const forest = RandomForest.fit(X, y, {
    seed: Math.floor(Math.random() * 2 ** 31),
    weights: W,
  });
  if (persist) await saveRecommendForest(forest);
  return { trained: X.length, posSamples: positives, negSamples: negatives, forest };
}

// Rebuild the sequence-memory tables from scratch by walking all 'focus'
// events in order — after a schema bump, an import, or to verify what drives
// the sequence model. History-bootstrap events (no tabId) are skipped.
export async function rebuildSequenceMemory(): Promise<{
  observed: number;
  bigramKeys: number;
}> {
  // Only focus events, straight off the [type+ts] index.
  const events = await db.events
    .where('[type+ts]')
    .between(['focus', 0], ['focus', Infinity], true, true)
    .toArray();
  const seq = new DomainSequenceMemory();
  const history: string[] = [];
  let observed = 0;
  for (const e of events) {
    if (!e.domain) continue;
    if (e.tabId === undefined) continue; // skip synthetic / non-tab events
    const hour = e.hourOfDay ?? new Date(e.ts).getHours();
    if (history.length >= 1) {
      seq.observe(history, e.domain, e.ts, hour);
      observed += 1;
    }
    // Dedupe consecutive same-domain focuses to mirror the live SW path.
    if (history[history.length - 1] !== e.domain) {
      history.push(e.domain);
      if (history.length > 8) history.shift();
    }
  }
  // Replace the live table: drop any pending write of the old in-memory copy
  // and the cache itself, or the next tab switch would save the stale table
  // straight back over this rebuild.
  discardDirty('recommend.sequence');
  await saveSequenceMemory(seq);
  clearSequenceMemoryCache();
  return { observed, bigramKeys: Object.keys(seq.state.bigram).length };
}

// Replay implicit training for both heads over the newest REPLAY_CAP events
// (point-in-time features; the walk itself covers all history so cumulative
// aggregates are right). Doesn't reset weights — appends gradient steps.
// Used to warm up freshly-bumped models and after an import. The walk also
// rebuilds the sequence memory and factorized transition model exactly as
// the SW would have learned them, and installs those as the live ones.
// The cap was 5000 events — about five days for a heavy user, so a warm-up
// trained on a sliver of history. The walk covers everything regardless and
// a training point costs ~2 ms, so the cap now only bounds pathological logs.
const REPLAY_CAP = 60_000;

export async function replayImplicitTraining(opts: { cap?: number } = {}): Promise<{
  openSamples: number;
  cleanupSamples: number;
  cleanupClosed: number; // of cleanupSamples, labelled "closed while backgrounded"
}> {
  const events = await db.events.orderBy('ts').toArray();
  const cap = opts.cap ?? REPLAY_CAP;
  const windowStart = events.length > cap ? events[events.length - cap].ts : -Infinity;
  const pit = new PointInTimeAggregates();
  const models = await pitModels(pit);
  const dwellIdx = buildDwellIndex(events);
  const closeBursts = windowCloseBursts(events);
  // Per-tab state reconstructed from the log, for cleanup outcome labels.
  const tabs = new Map<number, TabRuntimeState>();

  let openCount = 0;
  let cleanupCount = 0;
  let closedCount = 0;

  await walkEvents(events, pit, async (e, point) => {
    const inWindow = e.ts >= windowStart;
    const tid = e.tabId;

    // ── Cleanup outcomes (refocused vs closed-while-backgrounded) ─────
    // blur/close rows carry no url — requiring one here meant no tab was
    // ever marked backgrounded, so every refocus outcome was missed.
    if (tid !== undefined && e.domain) {
      let st = tabs.get(tid);
      if (!st && e.url && (e.type === 'open' || e.type === 'navigate' || e.type === 'focus')) {
        st = {
          tabId: tid,
          url: e.url,
          domain: e.domain,
          title: e.title,
          openedAt: e.ts,
          focusMs: 0,
          focusCount: 0,
          pinned: false,
          groupId: -1,
        };
        tabs.set(tid, st);
      }
      if (st) {
        if (e.type === 'navigate' && e.url) {
          st.url = e.url;
          st.domain = e.domain;
          st.title = e.title ?? st.title;
        } else if (e.type === 'focus') {
          // Switching (from another tab) to a backgrounded or never-viewed
          // tab — same rule as the live path in startFocusSegment. The
          // ≥30-min idle gate lives in trainCleanupOutcome.
          if (inWindow && st.focusedAt === undefined && e.prevTabId !== undefined && e.prevTabId !== tid) {
            const stats = await pit.source(e.ts).stats(st.domain);
            if (await trainCleanupOutcome({ features: outcomeFeatures(st, stats, e.ts), outcome: 'refocused' })) {
              cleanupCount += 1;
            }
          }
          st.focusedAt = e.ts;
          st.focusCount += 1;
        } else if (e.type === 'blur' && st.focusedAt !== undefined) {
          st.focusMs += e.focusMs ?? Math.max(0, e.ts - st.focusedAt);
          st.focusedAt = undefined;
          st.lastFocusedAt = e.ts;
        } else if (e.type === 'close') {
          const windowClosing =
            (e.meta as Record<string, unknown> | undefined)?.windowClosing === true ||
            closeBursts.has(e.ts);
          if (inWindow && st.focusedAt === undefined && !windowClosing) {
            const stats = await pit.source(e.ts).stats(st.domain);
            if (await trainCleanupOutcome({ features: outcomeFeatures(st, stats, e.ts), outcome: 'closed' })) {
              cleanupCount += 1;
              closedCount += 1;
            }
          }
          tabs.delete(tid);
        }
      }
    }

    // ── Open head ─────────────────────────────────────────────────────
    if (point && inWindow) {
      const trained = await trainImplicitOpen(e, {
        focusHistory: point.focusHistory,
        focusedDomain: point.focusedDomain,
        openDomains: point.openDomains,
        recentlyFocusedDomains: point.recentlyFocused,
        sessionStartTs: point.sessionStartTs,
        sampleWeight: sampleWeight(dwellAfter(dwellIdx, tid, e.ts), e.openedFrom),
        source: pit.source(e.ts),
        models,
      });
      if (trained) openCount += 1;
    }
  });

  await adoptSequenceMemory(pit.seq);
  await adoptTransition(pit.transition);
  return { openSamples: openCount, cleanupSamples: cleanupCount, cleanupClosed: closedCount };
}

// Timestamps (ms) at which ≥3 tabs closed within the same second — a window
// (or the browser) closing, not individual cleanup decisions. Used for
// historical rows logged before close events carried meta.windowClosing.
function windowCloseBursts(events: TabEvent[]): Set<number> {
  const out = new Set<number>();
  const closes = events.filter((e) => e.type === 'close');
  for (let i = 0; i < closes.length; i++) {
    let j = i;
    while (j + 1 < closes.length && closes[j + 1].ts - closes[i].ts < 1000) j++;
    if (j - i + 1 >= 3) for (let k = i; k <= j; k++) out.add(closes[k].ts);
    i = j;
  }
  return out;
}
