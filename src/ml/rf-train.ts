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
import type { TabEvent } from '../shared/types';
import { getDomainStats, getTopDomainsByFrecency } from './aggregate';
import { getEmbedding } from './embedding-train';
import {
  buildRecommendFeatures,
  RECOMMEND_FEATURE_NAMES,
  vectorFromRecommend,
} from './features';
import { sessionContext, visitVelocity } from './timeseries';
import { DomainSequenceMemory } from './models/markov';
import { RandomForest } from './models/randomforest';
import {
  loadSequenceMemory,
  saveRecommendForest,
  saveSequenceMemory,
} from './persistence';

const MAX_EVENTS = 1500;        // cap event scan for runtime budget
const NEGATIVE_SAMPLES = 3;     // per positive
const HISTORY_LOOKBACK = 6;     // how many prior focuses to use as history per event
const POSITIVE_LOOKBACK_DAYS = 30;

// Walk events in chronological order, tracking the rolling focus history
// at each point in time. For each open/navigate event, emit (positive
// features, label=1) for the opened domain plus N random negatives sampled
// from currently-popular domains.
export async function trainRecommendForest(): Promise<{
  trained: number;
  posSamples: number;
  negSamples: number;
}> {
  const cutoff = Date.now() - POSITIVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  // Pull only trackable open/navigate events (skip 'history-bootstrap' synthetic
  // ones — they have no real focus context).
  const events = await db.events
    .where('ts')
    .between(cutoff, Date.now(), true, true)
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
  if (usable.length === 0) {
    return { trained: 0, posSamples: 0, negSamples: 0 };
  }

  const embedding = await getEmbedding();
  const seq = await loadSequenceMemory();
  const negPool = await getTopDomainsByFrecency(80);
  const negDomains = negPool
    .map((p) => p.domain)
    .filter((d) => d && !d.startsWith('chrome'));

  // Rolling focus history — domains in chronological order of focus events.
  const focusHistory: string[] = [];

  const X: number[][] = [];
  const y: number[] = [];
  let positives = 0;
  let negatives = 0;

  for (let i = 0; i < usable.length; i++) {
    const event = usable[i];
    if (event.type === 'focus') {
      // Just maintain history; not a training event itself.
      if (event.domain && focusHistory[focusHistory.length - 1] !== event.domain) {
        focusHistory.push(event.domain);
        if (focusHistory.length > HISTORY_LOOKBACK) focusHistory.shift();
      }
      continue;
    }
    // Open or navigate — training event.
    const ts = event.ts;
    const hour = event.hourOfDay ?? new Date(ts).getHours();
    const dow = event.dayOfWeek ?? new Date(ts).getDay();
    const focusedDomain =
      focusHistory.length > 0 ? focusHistory[focusHistory.length - 1] : undefined;
    const openDomains = focusHistory.slice(-3); // approximate

    const buildFor = async (domain: string): Promise<number[] | null> => {
      const stats = await getDomainStats(domain);
      if (!stats) return null;
      const embedSim = focusedDomain ? embedding.cosine(domain, focusedDomain) : 0;
      const [vel, ses] = await Promise.all([
        visitVelocity(domain, ts),
        sessionContext(domain, ts),
      ]);
      const sShort = seq.predictShort(focusHistory, domain, ts);
      const sLong = seq.predictLong(focusHistory, domain, embedding);
      const sTime = seq.predictTime(focusHistory, domain, hour);
      const features = await buildRecommendFeatures({
        domain,
        context: { hour, dow, focusedDomain, openDomains },
        isCurrentlyOpen: false,
        isPinnedSomewhere: false,
        embedSimToFocused: embedSim,
        visitVelocity: vel,
        sessionContext: ses,
        seqProbShort: sShort,
        seqProbLong: sLong,
        seqProbTime: sTime,
        now: ts,
      });
      return vectorFromRecommend(features);
    };

    const posFeat = await buildFor(event.domain!);
    if (posFeat) {
      X.push(posFeat);
      y.push(1);
      positives += 1;
    }

    // Negatives: random non-opened domains from the frecency pool.
    const eligible = negDomains.filter((d) => d !== event.domain);
    for (let n = 0; n < NEGATIVE_SAMPLES && eligible.length > 0; n++) {
      const d = eligible[Math.floor(Math.random() * eligible.length)];
      const negFeat = await buildFor(d);
      if (negFeat) {
        X.push(negFeat);
        y.push(0);
        negatives += 1;
      }
    }

    // Update focus history for the next event in time.
    if (event.domain && focusHistory[focusHistory.length - 1] !== event.domain) {
      focusHistory.push(event.domain);
      if (focusHistory.length > HISTORY_LOOKBACK) focusHistory.shift();
    }
  }

  if (X.length < 20) {
    // Not enough data for a meaningful tree — skip training rather than
    // overwriting a previously-trained forest with a noisy one.
    return { trained: 0, posSamples: positives, negSamples: negatives };
  }

  const feats = RECOMMEND_FEATURE_NAMES.length;
  if (X[0].length !== feats) {
    // Feature count drift — the LR was loaded with the new shape but stale
    // saved features in the dataset can have a different length. Skip.
    return { trained: 0, posSamples: positives, negSamples: negatives };
  }

  const forest = RandomForest.fit(X, y, { seed: Math.floor(Date.now() / 1000) });
  await saveRecommendForest(forest);
  return { trained: X.length, posSamples: positives, negSamples: negatives };
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
  const events = await db.events.orderBy('ts').toArray();
  const seq = new DomainSequenceMemory();
  const history: string[] = [];
  let observed = 0;
  for (const e of events) {
    if (e.type !== 'focus') continue;
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
  await saveSequenceMemory(seq);
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
const REPLAY_CAP = 1000;

export async function replayImplicitTraining(): Promise<{
  openSamples: number;
  cleanupSamples: number;
}> {
  // Lazy-import to avoid circular deps — recommend.ts imports from
  // persistence.ts which imports from models/randomforest.ts which is
  // loaded by this file at top-level.
  const { trainImplicitOpen } = await import('./recommend');
  const { trainImplicitCleanup } = await import('./cleanup');
  const { buildCleanupFeatures } = await import('./features');

  const events = await db.events.orderBy('ts').toArray();
  const recent = events.slice(-REPLAY_CAP);

  // Maintain rolling focus history so trainImplicitOpen sees realistic
  // context at each replay step.
  const history: string[] = [];
  const openTabIds = new Set<number>();

  let openCount = 0;
  let cleanupCount = 0;

  for (const e of recent) {
    if (e.tabId !== undefined && (e.type === 'open' || e.type === 'navigate')) {
      openTabIds.add(e.tabId);
    }
    if (e.tabId !== undefined && e.type === 'close') {
      openTabIds.delete(e.tabId);
    }
    if (e.type === 'focus' && e.domain) {
      if (history.length === 0 || history[history.length - 1] !== e.domain) {
        history.push(e.domain);
        if (history.length > 8) history.shift();
      }
    }
    if (
      (e.type === 'open' || e.type === 'navigate') &&
      e.domain &&
      e.tabId !== undefined
    ) {
      const meta = e.meta as Record<string, unknown> | undefined;
      if (meta?.source === 'history-bootstrap') continue;
      const focusedDomain =
        history.length > 0 ? history[history.length - 1] : undefined;
      await trainImplicitOpen(e, {
        focusHistory: [...history],
        focusedDomain,
        // We don't know exact open-tab domain set at the moment — best
        // effort: just current focus history. Negatives still sample from
        // current frecency pool inside trainImplicitOpen.
        openDomains: history,
      });
      openCount += 1;
    }
    if (e.type === 'close' && e.domain && e.url) {
      // Synthesize a CleanupFeatures snapshot from the closed event's
      // recorded fields. We don't have all the per-tab state, but
      // trainImplicitCleanup just needs `focusRate`, `tabAgeMs`,
      // `timeSinceFocusMs`, `focusCount` — which are derivable.
      const tabAgeMs = e.durationMs ?? 0;
      const focusMs = e.focusMs ?? 0;
      const focusCount = e.focusCount ?? 0;
      const features = buildCleanupFeatures({
        tab: {
          id: e.tabId,
          url: e.url,
          title: e.title,
          pinned: false,
          active: false,
          groupId: -1,
        } as chrome.tabs.Tab,
        state: {
          tabId: e.tabId ?? -1,
          url: e.url,
          domain: e.domain,
          openedAt: e.ts - tabAgeMs,
          focusMs,
          focusCount,
          pinned: false,
          groupId: -1,
        },
        stats: undefined,
        sameDomainOpenCount: 1,
        now: e.ts,
      });
      await trainImplicitCleanup({
        features,
        domain: e.domain,
        closedByUser: true,
      });
      cleanupCount += 1;
    }
  }

  return { openSamples: openCount, cleanupSamples: cleanupCount };
}

