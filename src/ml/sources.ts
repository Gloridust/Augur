// Where the feature builder reads per-domain aggregates from, AS OF a fixed
// instant `now` (strictly-before semantics: nothing at or after `now`).
//
//   liveSource(now)  — the IndexedDB tables. Correct for serving, and for live
//                      training because the SW trains on an event BEFORE
//                      writing it.
//   pit.source()     — point-in-time aggregates rebuilt from the event log
//                      (./pit). Used by replay, the forest trainer and the
//                      evaluator, which learn from / score PAST events: the
//                      live tables already contain those events and everything
//                      after them, which leaked the answer into the features.
//
// One interface, one feature builder (./candidate-features) — the train and
// serve paths can't drift apart again.

import { db } from '../shared/db';
import type { CoOccurrence, DomainStats } from '../shared/types';
import { pairCountAt, topByFrecency } from './aggregate';
import {
  buildTimeseriesSnapshot,
  sessionContext as sessionQuery,
  type TimeseriesSnapshot,
  visitVelocity as velocityQuery,
} from './timeseries';

export interface AggregateSource {
  readonly now: number;
  stats(domain: string): Promise<DomainStats | undefined>;
  // Co-occurrence count of the pair (domain, partner).
  cooccurrence(domain: string, partner: string): Promise<number>;
  // open/navigate rate last 24h vs 14-day baseline, capped at 5.
  velocity(domain: string): Promise<number>;
  // 1 if the domain was opened/navigated/focused in the last 30 min.
  session(domain: string): Promise<number>;
  topByFrecency(k: number): Promise<DomainStats[]>;
  domains(): Promise<string[]>;
}

// DB-backed source. Loads the domains table once per instance and the
// co-occurrence rows of each partner once, so scoring ~120 candidates costs a
// handful of queries instead of ~240 sequential round-trips. Pass a
// timeseries snapshot when scoring many candidates (one 14-day scan) —
// otherwise velocity/session use per-domain indexed queries (cheap for the
// ~6 candidates of a training group).
export function liveSource(now: number, snapshot?: TimeseriesSnapshot): AggregateSource {
  let domainsP: Promise<Map<string, DomainStats>> | null = null;
  const partnerRows = new Map<string, Promise<Map<string, number>>>();

  const domainMap = () =>
    (domainsP ??= db.domains.toArray().then((rows) => new Map(rows.map((r) => [r.domain, r]))));

  const pairsOf = (partner: string) => {
    let p = partnerRows.get(partner);
    if (!p) {
      p = Promise.all([
        db.cooccurrence.where('a').equals(partner).toArray(),
        db.cooccurrence.where('b').equals(partner).toArray(),
      ]).then(([as, bs]) => {
        const m = new Map<string, number>();
        for (const r of [...as, ...bs] as CoOccurrence[]) {
          m.set(r.a === partner ? r.b : r.a, pairCountAt(r, now));
        }
        return m;
      });
      partnerRows.set(partner, p);
    }
    return p;
  };

  return {
    now,
    async stats(domain) {
      return (await domainMap()).get(domain);
    },
    async cooccurrence(domain, partner) {
      if (!domain || !partner || domain === partner) return 0;
      return (await pairsOf(partner)).get(domain) ?? 0;
    },
    async velocity(domain) {
      return snapshot ? snapshot.velocityOf(domain) : velocityQuery(domain, now);
    },
    async session(domain) {
      return snapshot ? snapshot.sessionOf(domain) : sessionQuery(domain, now);
    },
    async topByFrecency(k) {
      return topByFrecency((await domainMap()).values(), k, now);
    },
    async domains() {
      return [...(await domainMap()).keys()];
    },
  };
}

export async function servingSource(now: number): Promise<{
  source: AggregateSource;
  snapshot: TimeseriesSnapshot;
}> {
  const snapshot = await buildTimeseriesSnapshot(now);
  return { source: liveSource(now, snapshot), snapshot };
}

