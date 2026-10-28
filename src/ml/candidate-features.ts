// THE feature builder for the open-recommendation head.
//
// Every path that turns "a candidate domain at some moment" into the 30-dim
// feature vector goes through buildCandidateFeatures: live serving, live
// training, the replay trainer, the forest trainer, the evaluator and the pin
// re-ranker. Before this module the same assembly was hand-copied in three
// places (plus a fourth, partial one in pins.ts that left 19 features at
// defaults), and the copies drifted — that drift is how the isCurrentlyOpen
// leak and the pin-scoring skew happened.
//
// Inputs are split by provenance:
//   AggregateSource (./sources) — per-domain statistics as of fc.ts; live DB
//     or point-in-time replay.
//   ModelBundle — the learned sequence/transition/embedding/text models; live
//     caches, or point-in-time ones for the sequence + transition models.

import type { RecommendFeatures } from '../shared/types';
import { dinAttention } from './attention';
import type { DomainTextState } from './domaintext';
import { sessionTextVec, textSim, vecOf } from './domaintext';
import { buildRecommendFeatures, buildSessionVector } from './features';
import type { BetaBandit } from './models/bandit';
import type { SkipGramEmbedding } from './models/embedding';
import type { DomainSequenceMemory } from './models/markov';
import type { TransitionModel } from './models/transition';
import type { AggregateSource } from './sources';
import { textCosine } from './textembed';
import type { UrlPrefixState } from './urlprefix';
import { topPrefixFrom } from './urlprefix';

export interface ModelBundle {
  embedding: SkipGramEmbedding;
  seq: DomainSequenceMemory;
  transition: TransitionModel;
  bandit: BetaBandit;
  prefixes: UrlPrefixState;
  domainText: DomainTextState;
  hourActivityZ(hour: number): number;
}

// Everything about "the moment" that's shared by all candidates — computed
// once per scoring call / training group.
export interface FeatureContext {
  ts: number;
  hour: number;
  dow: number;
  focusHistory: string[];
  focusedDomain?: string;
  openDomains: string[];
  minutesIntoSession: number;
  isSessionStart: number;
  session: { vec: Float64Array | null; cohesion: number };
  sessTextVec: Float32Array | null;
  hourZ: number;
}

export function makeFeatureContext(
  args: {
    ts: number;
    hour?: number;
    dow?: number;
    focusHistory: string[];
    focusedDomain?: string;
    openDomains?: string[];
    sessionStartTs?: number;
  },
  m: ModelBundle,
): FeatureContext {
  const d = new Date(args.ts);
  const hour = args.hour ?? d.getHours();
  const sessionStartTs = args.sessionStartTs ?? args.ts;
  const focusedDomain =
    args.focusedDomain ?? args.focusHistory[args.focusHistory.length - 1];
  return {
    ts: args.ts,
    hour,
    dow: args.dow ?? d.getDay(),
    focusHistory: args.focusHistory,
    focusedDomain,
    openDomains: args.openDomains ?? [],
    minutesIntoSession: Math.max(0, Math.min(120, (args.ts - sessionStartTs) / 60_000)),
    isSessionStart: args.ts - sessionStartTs < 60_000 ? 1 : 0,
    session: buildSessionVector(args.focusHistory, m.embedding, m.embedding.dim),
    sessTextVec: sessionTextVec(m.domainText, args.focusHistory.slice(-8)),
    hourZ: m.hourActivityZ(hour),
  };
}

export async function buildCandidateFeatures(
  fc: FeatureContext,
  domain: string,
  src: AggregateSource,
  m: ModelBundle,
  opts: { isCurrentlyOpen?: boolean; isPinnedSomewhere?: boolean } = {},
): Promise<RecommendFeatures> {
  const focused = fc.focusedDomain;
  const [stats, velocity, session, cooccurrence] = await Promise.all([
    src.stats(domain),
    src.velocity(domain),
    src.session(domain),
    focused ? src.cooccurrence(domain, focused) : Promise.resolve(0),
  ]);
  const dtVec = vecOf(m.domainText, domain);
  return buildRecommendFeatures({
    domain,
    context: { hour: fc.hour, dow: fc.dow, focusedDomain: focused, openDomains: fc.openDomains },
    stats: stats ?? null,
    cooccurrence,
    isCurrentlyOpen: opts.isCurrentlyOpen ?? false,
    isPinnedSomewhere: opts.isPinnedSomewhere ?? false,
    embedSimToFocused: focused ? m.embedding.cosine(domain, focused) : 0,
    visitVelocity: velocity,
    sessionContext: session,
    seqProbShort: m.seq.predictShort(fc.focusHistory, domain, fc.ts),
    seqProbLong: m.seq.predictLong(fc.focusHistory, domain, m.embedding),
    seqProbTime: m.seq.predictTime(fc.focusHistory, domain, fc.hour),
    transitionAffinity: focused ? m.embedding.directedScore(focused, domain) : 0,
    sessionSim: fc.session.vec ? m.embedding.cosineToVector(domain, fc.session.vec) : 0,
    sessionCohesion: fc.session.cohesion,
    minutesIntoSession: fc.minutesIntoSession,
    isSessionStart: fc.isSessionStart,
    hourActivityZ: fc.hourZ,
    banditLogit: m.bandit.logit(domain),
    prefixConcentration: topPrefixFrom(m.prefixes, domain).concentration,
    titleSimToFocused: focused ? textSim(m.domainText, domain, focused) : 0,
    titleSimToSession: fc.sessTextVec && dtVec ? textCosine(dtVec, fc.sessTextVec) : 0,
    factorizedTransition: focused ? m.transition.score(focused, domain) : 0.5,
    dinAttention: dinAttention(m.embedding, fc.focusHistory, domain),
    now: fc.ts,
  });
}
