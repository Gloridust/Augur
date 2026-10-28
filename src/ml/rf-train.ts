// Offline batch trainer for the RandomForest recommend head. Runs from the
// SW's nightlyDecay alarm. Walks recent open/navigate events, builds a
// (X, y) supervised dataset by treating each opened domain as a positive and
// pairing it with random non-opened negatives in the same context, then
// fits the forest and persists it.
//
// Crucially this DOESN'T touch the OnlineLogReg — both heads coexist. At
// inference time `recommendOpen` ensembles their scores. LR keeps absorbing
// fresh signal between batches; RF captures the non-linear interactions LR
// can't and gives a stable second opinion.

import { db } from '../shared/db';
import type { TabEvent, TabRuntimeState } from '../shared/types';
import { getDomainStats } from './aggregate';
import { dinAttention } from './attention';
import { getEmbedding } from './embedding-train';
import {
  buildRecommendFeatures,
  buildSessionVector,
  RECOMMEND_FEATURE_NAMES,
  vectorFromRecommend,
} from './features';
import { clearSequenceMemoryCache, trainImplicitOpen } from './recommend';
import { discardDirty } from './flush';
import { outcomeFeatures, trainCleanupOutcome } from './cleanup';
import { sessionContext, visitVelocity } from './timeseries';
import { DomainSequenceMemory } from './models/markov';
import { RandomForest } from './models/randomforest';
import { loadBandit, loadTransition } from './persistence';
import { hourActivityZFrom, loadCircadian } from './circadian';
import { loadUrlPrefixes, topPrefixFrom } from './urlprefix';
import { loadDomainText, sessionTextVec, textSim, vecOf } from './domaintext';
import { textCosine } from './textembed';
import {
  loadSequenceMemory,
  saveRecommendForest,
  saveSequenceMemory,
} from './persistence';

const MAX_EVENTS = 1500;        // cap event scan for runtime budget
const NEGATIVE_SAMPLES = 3;     // per positive
const HISTORY_LOOKBACK = 8;     // how many prior focuses to use as history per event
const POSITIVE_LOOKBACK_DAYS = 30;
const SESSION_GAP_MS = 30 * 60 * 1000;     // >30min event gap = new session
const RECENT_FOCUS_MS = 2 * 60 * 1000;     // switch-event lookback (Phase 1.1; 15→2min, see recommend.ts)
const SESSION_DEDUP_MS = 30 * 60 * 1000;   // ≤1 positive per (domain, window)

// Engagement × openedFrom sample weight (Phase 1.3 + 1.4). `focusMs` is the
// dwell the user gave the opened tab afterward (forward-joined from its
// eventual close); `openedFrom` reflects intent. Clipped to [0.5, 2.0].
function sampleWeight(focusMs: number, openedFrom: string | undefined): number {
  const engagement = Math.max(0.5, Math.min(2.0, Math.log1p(focusMs / 30_000)));
  const intent = openedFrom === 'direct' ? 1.2 : openedFrom === 'link' ? 0.8 : 1.0;
  return Math.max(0.5, Math.min(2.0, engagement * intent));
}

// Forward-join: for each open event, the dwell time on that tab is recorded
// on its eventual `close` event (focusMs). Build tabId → sorted close
// records so we can look up "how long did this open last".
function buildDwellIndex(events: TabEvent[]): Map<number, Array<{ ts: number; focusMs: number }>> {
  const idx = new Map<number, Array<{ ts: number; focusMs: number }>>();
  for (const e of events) {
    if (e.type !== 'close' || e.tabId === undefined) continue;
    const arr = idx.get(e.tabId) ?? [];
    arr.push({ ts: e.ts, focusMs: e.focusMs ?? 0 });
    idx.set(e.tabId, arr);
  }
  for (const arr of idx.values()) arr.sort((a, b) => a.ts - b.ts);
  return idx;
}

function dwellAfter(
  idx: Map<number, Array<{ ts: number; focusMs: number }>>,
  tabId: number | undefined,
  openTs: number,
): number {
  if (tabId === undefined) return 0;
  const arr = idx.get(tabId);
  if (!arr) return 0;
  for (const rec of arr) if (rec.ts >= openTs) return rec.focusMs;
  return 0;
}

// Walk events in chronological order, tracking the rolling focus history
// at each point in time. For each open/navigate event, emit (positive
// features, label=1) for the opened domain plus N random negatives sampled
// from currently-popular domains.
export async function trainRecommendForest(
  // endTs: train only on events before this instant (the backtest uses the
  // split point so the forest never sees test-period events).
  // persist=false: return the forest without overwriting the live one.
  opts: { endTs?: number; persist?: boolean } = {},
): Promise<{
  trained: number;
  posSamples: number;
  negSamples: number;
  forest?: RandomForest;
}> {
  const endTs = opts.endTs ?? Date.now();
  const persist = opts.persist ?? true;
  const cutoff = endTs - POSITIVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  // Pull only trackable open/navigate events (skip 'history-bootstrap' synthetic
  // ones — they have no real focus context). NEWEST-first: the old code took
  // the first MAX_EVENTS in ascending order, i.e. the oldest 1500 events of
  // the 30-day window, so a busy user's forest never saw their recent weeks.
  const events = await db.events
    .where('ts')
    .between(cutoff, endTs, true, false)
    .reverse()
    .toArray();

  const usable: TabEvent[] = [];
  for (const e of events) {
    if (e.type !== 'open' && e.type !== 'navigate' && e.type !== 'focus') continue;
    if (!e.domain) continue;
    const meta = e.meta as Record<string, unknown> | undefined;
    if (meta?.source === 'history-bootstrap') continue;
    usable.push(e);
    if (usable.length >= MAX_EVENTS) break;
  }
  usable.reverse(); // back to chronological for the context walk
  if (usable.length === 0) {
    return { trained: 0, posSamples: 0, negSamples: 0 };
  }

  const embedding = await getEmbedding();
  const seq = await loadSequenceMemory();
  const bandit = await loadBandit('recommend');
  const circadian = await loadCircadian();
  const prefixes = await loadUrlPrefixes();
  const transition = await loadTransition();
  const domainText = await loadDomainText();
  const allDomainRows = await db.domains.toArray();
  const uniformNegDomains = allDomainRows
    .map((p) => p.domain)
    .filter((d) => d && !d.startsWith('chrome'));

  const dwellIdx = buildDwellIndex(usable);

  // Rolling focus history + session/recency tracking for the switch filter.
  const focusHistory: string[] = [];
  const recentFocus: Array<{ domain: string; ts: number }> = [];
  const lastPositiveTs = new Map<string, number>(); // (domain) → last positive ts
  let sessionStartTs = usable[0]?.ts ?? Date.now();
  let lastEventTs = sessionStartTs;

  const X: number[][] = [];
  const y: number[] = [];
  const W: number[] = [];
  let positives = 0;
  let negatives = 0;

  for (let i = 0; i < usable.length; i++) {
    const event = usable[i];
    const ts = event.ts;
    if (ts - lastEventTs > SESSION_GAP_MS) sessionStartTs = ts;
    lastEventTs = ts;

    if (event.type === 'focus') {
      if (event.domain && focusHistory[focusHistory.length - 1] !== event.domain) {
        focusHistory.push(event.domain);
        if (focusHistory.length > HISTORY_LOOKBACK) focusHistory.shift();
      }
      if (event.domain) recentFocus.push({ domain: event.domain, ts });
      continue;
    }
    const hour = event.hourOfDay ?? new Date(ts).getHours();
    const dow = event.dayOfWeek ?? new Date(ts).getDay();
    const focusedDomain =
      focusHistory.length > 0 ? focusHistory[focusHistory.length - 1] : undefined;
    const openDomains = focusHistory.slice(-3);

    // ── Phase 1.1 switch filter + 1.2 session dedup ─────────────────
    while (recentFocus.length && ts - recentFocus[0].ts > RECENT_FOCUS_MS) {
      recentFocus.shift();
    }
    const recentSet = new Set(recentFocus.map((r) => r.domain));
    const isSwitch =
      !!event.domain &&
      event.domain !== focusedDomain &&
      !recentSet.has(event.domain);
    const lastPos = lastPositiveTs.get(event.domain ?? '');
    const deduped = lastPos !== undefined && ts - lastPos < SESSION_DEDUP_MS;

    // Always advance focus history before continuing, even when we skip.
    const advance = () => {
      if (event.domain) {
        if (focusHistory[focusHistory.length - 1] !== event.domain) {
          focusHistory.push(event.domain);
          if (focusHistory.length > HISTORY_LOOKBACK) focusHistory.shift();
        }
        recentFocus.push({ domain: event.domain, ts });
      }
    };
    if (!isSwitch || deduped) {
      advance();
      continue;
    }
    lastPositiveTs.set(event.domain!, ts);

    const session = buildSessionVector(focusHistory, embedding, embedding.dim);
    const sessTextVec = sessionTextVec(domainText, focusHistory.slice(-8));
    const minutesIntoSession = Math.max(0, Math.min(120, (ts - sessionStartTs) / 60_000));
    const isSessionStart = ts - sessionStartTs < 60_000 ? 1 : 0;
    const hourZ = hourActivityZFrom(circadian, hour);

    const buildFor = async (domain: string): Promise<number[] | null> => {
      const stats = await getDomainStats(domain);
      if (!stats) return null;
      const embedSim = focusedDomain ? embedding.cosine(domain, focusedDomain) : 0;
      const [vel, ses] = await Promise.all([
        visitVelocity(domain, ts),
        sessionContext(domain, ts),
      ]);
      const features = await buildRecommendFeatures({
        domain,
        context: { hour, dow, focusedDomain, openDomains },
        stats, // already fetched above — skip the builder's re-fetch
        isCurrentlyOpen: false,
        isPinnedSomewhere: false,
        embedSimToFocused: embedSim,
        visitVelocity: vel,
        sessionContext: ses,
        seqProbShort: seq.predictShort(focusHistory, domain, ts),
        seqProbLong: seq.predictLong(focusHistory, domain, embedding),
        seqProbTime: seq.predictTime(focusHistory, domain, hour),
        transitionAffinity: focusedDomain ? embedding.directedScore(focusedDomain, domain) : 0,
        sessionSim: session.vec ? embedding.cosineToVector(domain, session.vec) : 0,
        sessionCohesion: session.cohesion,
        minutesIntoSession,
        isSessionStart,
        hourActivityZ: hourZ,
        banditLogit: bandit.logit(domain),
        prefixConcentration: topPrefixFrom(prefixes, domain).concentration,
        titleSimToFocused: focusedDomain ? textSim(domainText, domain, focusedDomain) : 0,
        titleSimToSession: (() => {
          const v = vecOf(domainText, domain);
          return sessTextVec && v ? textCosine(v, sessTextVec) : 0;
        })(),
        factorizedTransition: focusedDomain ? transition.score(focusedDomain, domain) : 0.5,
        dinAttention: dinAttention(embedding, focusHistory, domain),
        now: ts,
      });
      return vectorFromRecommend(features);
    };

    const w = sampleWeight(dwellAfter(dwellIdx, event.tabId, ts), event.openedFrom);

    const posFeat = await buildFor(event.domain!);
    if (posFeat) {
      X.push(posFeat);
      y.push(1);
      W.push(w);
      positives += 1;
    }

    const negSampled: string[] = [];
    const hard = seq
      .topPredictions(focusHistory, hour, ts, 10)
      .map((p) => p.domain)
      .find(
        (d) => d && d !== event.domain && d !== focusedDomain && !d.startsWith('chrome'),
      );
    if (hard) negSampled.push(hard);
    const easyEligible = uniformNegDomains.filter(
      (d) => d !== event.domain && d !== focusedDomain && !negSampled.includes(d),
    );
    while (negSampled.length < NEGATIVE_SAMPLES && easyEligible.length > 0) {
      const idx = Math.floor(Math.random() * easyEligible.length);
      negSampled.push(easyEligible[idx]);
      easyEligible.splice(idx, 1);
    }
    for (const d of negSampled) {
      const negFeat = await buildFor(d);
      if (negFeat) {
        X.push(negFeat);
        y.push(0);
        W.push(1.0); // negatives unweighted
        negatives += 1;
      }
    }

    advance();
  }

  if (X.length < 20) {
    return { trained: 0, posSamples: positives, negSamples: negatives };
  }
  if (X[0].length !== RECOMMEND_FEATURE_NAMES.length) {
    return { trained: 0, posSamples: positives, negSamples: negatives };
  }

  const forest = RandomForest.fit(X, y, {
    seed: Math.floor(Date.now() / 1000),
    weights: W,
  });
  if (persist) await saveRecommendForest(forest);
  return { trained: X.length, posSamples: positives, negSamples: negatives, forest };
}

// Rebuild the sequence-memory bigram / trigram / time-bigram tables from
// scratch by walking all `'focus'` events in db.events in chronological
// order. Useful when:
//   - you've just bumped the schema and the sequence memory was reset
//   - you've imported events from another machine
//   - you want to verify what's in the events table actually drives the
//     sequence model
// History-bootstrap synthesized events (no tabId, meta.source flag) are
// skipped — they have no real focus context.
export async function rebuildSequenceMemory(): Promise<{
  observed: number;
  bigramKeys: number;
}> {
  // Only focus events, straight off the [type+ts] index.
  const events = await db.events
    .where('[type+ts]')
    .between(['focus', 0], ['focus', Date.now()], true, true)
    .toArray();
  const seq = new DomainSequenceMemory();
  const history: string[] = [];
  let observed = 0;
  for (const e of events) {
    if (!e.domain) continue;
    if (e.tabId === undefined) continue; // skip synthetic / non-tab events
    // Dedupe consecutive same-domain focuses to mirror the live SW path.
    if (history.length > 0 && history[history.length - 1] === e.domain) continue;
    const hour = e.hourOfDay ?? new Date(e.ts).getHours();
    if (history.length >= 1) {
      seq.observe(history, e.domain, e.ts, hour);
      observed += 1;
    }
    history.push(e.domain);
    if (history.length > 8) history.shift();
  }
  // Replace the live table: drop any pending write of the old in-memory copy
  // and the cache itself, or the next tab switch would save the stale table
  // straight back over this rebuild.
  discardDirty('recommend.sequence');
  await saveSequenceMemory(seq);
  clearSequenceMemoryCache();
  return { observed, bigramKeys: Object.keys(seq.state.bigram).length };
}

// Replay the implicit-training path on the recommend & cleanup heads from
// the current events table. Doesn't reset weights — appends gradient steps
// on top of whatever's there. Useful for:
//   - warming up freshly-bumped models on existing event data
//   - re-running training after a code change to the trainer logic
//
// Sample size is capped to keep the runtime bounded; recent events are
// preferred so the model reflects current behavior rather than history.
// 5000 (was 1000): only genuine switch-opens become training groups (the
// Phase 1.1 filter), so ~1–2% of events qualify. 1000 events yielded only
// ~17 groups — not enough to cross the MLP's 50-group readiness floor in a
// single replay. 5000 yields ~60–90 switch-opens, enough for one click to
// warm the MLP past the threshold (and gives the LR a broader, still-recent
// training window). Runtime stays a few seconds — the expensive per-group
// feature-building only runs for the qualifying switch-opens, not all 5000.
const REPLAY_CAP = 5000;

export async function replayImplicitTraining(): Promise<{
  openSamples: number;
  cleanupSamples: number;
}> {
  // Bounded read: only the newest REPLAY_CAP events (the old code loaded the
  // entire, ever-growing events table and sliced it in memory).
  const recent = (await db.events.orderBy('ts').reverse().limit(REPLAY_CAP).toArray()).reverse();
  const dwellIdx = buildDwellIndex(recent);
  const statsByDomain = new Map((await db.domains.toArray()).map((s) => [s.domain, s]));
  const closeBursts = windowCloseBursts(recent);

  // Rolling focus history so trainImplicitOpen sees realistic context.
  const history: string[] = [];
  const recentFocus: Array<{ domain: string; ts: number }> = [];
  let sessionStartTs = recent[0]?.ts ?? Date.now();
  let lastEventTs = sessionStartTs;
  // Per-tab state reconstructed from the log, for cleanup outcome labels.
  const tabs = new Map<number, TabRuntimeState>();

  let openCount = 0;
  let cleanupCount = 0;

  for (const e of recent) {
    if (e.ts - lastEventTs > SESSION_GAP_MS) sessionStartTs = e.ts;
    lastEventTs = e.ts;
    const tid = e.tabId;

    // ── Cleanup outcomes (refocused vs closed-while-backgrounded) ─────
    if (tid !== undefined && e.domain && e.url) {
      let st = tabs.get(tid);
      if (!st && (e.type === 'open' || e.type === 'navigate' || e.type === 'focus')) {
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
        if (e.type === 'navigate') {
          st.url = e.url;
          st.domain = e.domain;
          st.title = e.title ?? st.title;
        } else if (e.type === 'focus') {
          // Switching (from another tab) to a backgrounded or never-viewed
          // tab — same rule as the live path in startFocusSegment. The
          // ≥30-min idle gate lives in trainCleanupOutcome.
          if (st.focusedAt === undefined && e.prevTabId !== undefined && e.prevTabId !== tid) {
            await trainCleanupOutcome({
              features: outcomeFeatures(st, statsByDomain.get(st.domain), e.ts),
              outcome: 'refocused',
            });
            cleanupCount += 1;
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
          if (st.focusedAt === undefined && !windowClosing) {
            await trainCleanupOutcome({
              features: outcomeFeatures(st, statsByDomain.get(st.domain), e.ts),
              outcome: 'closed',
            });
            cleanupCount += 1;
          }
          tabs.delete(tid);
        }
      }
    }

    if (e.type === 'focus' && e.domain) {
      if (history.length === 0 || history[history.length - 1] !== e.domain) {
        history.push(e.domain);
        if (history.length > 8) history.shift();
      }
      recentFocus.push({ domain: e.domain, ts: e.ts });
    }
    if ((e.type === 'open' || e.type === 'navigate') && e.domain && tid !== undefined) {
      const meta = e.meta as Record<string, unknown> | undefined;
      if (meta?.source === 'history-bootstrap') continue;
      const focusedDomain = history.length > 0 ? history[history.length - 1] : undefined;
      while (recentFocus.length && e.ts - recentFocus[0].ts > RECENT_FOCUS_MS) {
        recentFocus.shift();
      }
      // trainImplicitOpen applies the switch filter itself and reports
      // whether this event actually produced a training group.
      const trained = await trainImplicitOpen(e, {
        focusHistory: [...history],
        focusedDomain,
        openDomains: history,
        recentlyFocusedDomains: recentFocus.map((r) => r.domain),
        sessionStartTs,
        sampleWeight: sampleWeight(dwellAfter(dwellIdx, tid, e.ts), e.openedFrom),
      });
      if (trained) openCount += 1;
      recentFocus.push({ domain: e.domain, ts: e.ts });
    }
  }

  return { openSamples: openCount, cleanupSamples: cleanupCount };
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

