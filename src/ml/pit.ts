// Point-in-time aggregates: everything the feature builder needs, rebuilt by
// replaying the event log in order, queryable "as of" any instant.
//
// Training and evaluating on PAST events with the live tables is a leak: those
// tables already contain the event being learned from and everything after
// it. In the July 2026 audit this made sessionContext ("visited in the last
// 30 min"), recencyHours and visitVelocity the three most-weighted features —
// the positive always "looked just visited" because it had been — and
// inflated the backtest. Here, the caller asks for features BEFORE advancing
// past the event, so the features for an event at time t are built from
// events strictly before t, exactly as live serving sees the world.
//
// Mirrors the live rules exactly: domain stats + co-occurrence via the shared
// AggregateReplayer, timeseries windows matching ./timeseries, and a sequence
// memory + factorized transition model trained on focus transitions the same
// way the SW trains them (observeFocusTransition). Embeddings, the bandit,
// URL prefixes and page-text vectors still come from their current state — a
// diffuse residual leak, documented in doc/ML.md.

import type { DomainStats, TabEvent } from '../shared/types';
import { AggregateReplayer, pairCountAt, pairKey, topByFrecency } from './aggregate';
import { hourActivityZFrom } from './circadian';
import { DomainSequenceMemory } from './models/markov';
import { TransitionModel } from './models/transition';
import type { AggregateSource } from './sources';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VELOCITY_WINDOW_MS = DAY;
const VELOCITY_BASELINE_MS = 14 * DAY;
const SESSION_MS = 30 * 60_000;
const FOCUS_HISTORY_MAX = 8;

// Deterministic PRNG so evaluation runs are repeatable.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// First index with arr[i] >= x (arr ascending).
function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class PointInTimeAggregates {
  private agg = new AggregateReplayer();
  private activity = new Map<string, number[]>(); // open/navigate (velocity)
  private presence = new Map<string, number[]>(); // open/navigate/focus (session)
  private history: string[] = [];
  readonly seq = new DomainSequenceMemory();
  readonly transition = new TransitionModel();
  readonly hourCounts = new Array<number>(24).fill(0);
  private rng: () => number;

  constructor(seed = 1) {
    this.rng = mulberry32(seed);
  }

  // Apply one event. Call AFTER building any features that describe it.
  advance(e: TabEvent): void {
    this.agg.apply(e);
    const d = e.domain;
    if (!d) return;
    const hour = e.hourOfDay ?? new Date(e.ts).getHours();
    this.hourCounts[hour] += 1;
    if (e.type === 'open' || e.type === 'navigate') {
      push(this.activity, d, e.ts, e.ts - VELOCITY_BASELINE_MS);
      push(this.presence, d, e.ts, e.ts - SESSION_MS);
    } else if (e.type === 'focus') {
      push(this.presence, d, e.ts, e.ts - SESSION_MS);
      if (e.tabId === undefined) return;
      // Same as the SW: train on (history → domain), then push (deduped).
      if (this.history.length > 0) {
        const from = this.history[this.history.length - 1];
        this.seq.observe(this.history, d, e.ts, hour);
        if (from !== d && !from.startsWith('chrome') && !d.startsWith('chrome')) {
          const negs = this.transition.sampleNegatives(5, new Set([from, d]), this.rng);
          this.transition.observe(from, d, negs);
        }
      }
      if (this.history[this.history.length - 1] !== d) {
        this.history.push(d);
        if (this.history.length > FOCUS_HISTORY_MAX) this.history.shift();
      }
    }
  }

  // Same z-score as the live circadian feature (a scale-free statistic, so
  // the live table's nightly decay doesn't matter).
  hourActivityZ(hour: number): number {
    return hourActivityZFrom({ hourCounts: this.hourCounts, updatedAt: 0 }, hour);
  }

  // Aggregates as of `now` (strictly before it).
  source(now: number): AggregateSource {
    const statsMap = this.agg.stats;
    const pairs = this.agg.pairs;
    const activity = this.activity;
    const presence = this.presence;
    return {
      now,
      async stats(domain: string): Promise<DomainStats | undefined> {
        return statsMap.get(domain);
      },
      async cooccurrence(domain: string, partner: string): Promise<number> {
        if (!domain || !partner || domain === partner) return 0;
        const p = pairs.get(pairKey(domain, partner).pair);
        return p ? pairCountAt(p, now) : 0;
      },
      async velocity(domain: string): Promise<number> {
        const ts = activity.get(domain);
        if (!ts) return 0;
        const end = lowerBound(ts, now);
        const base = end - lowerBound(ts, now - VELOCITY_BASELINE_MS);
        if (base === 0) return 0;
        const recent = end - lowerBound(ts, now - VELOCITY_WINDOW_MS);
        return Math.min(5, recent / (base / 14));
      },
      async session(domain: string): Promise<number> {
        const ts = presence.get(domain);
        if (!ts) return 0;
        const i = lowerBound(ts, now) - 1;
        return i >= 0 && ts[i] >= now - SESSION_MS ? 1 : 0;
      },
      async topByFrecency(k: number): Promise<DomainStats[]> {
        return topByFrecency(statsMap.values(), k, now);
      },
      async domains(): Promise<string[]> {
        return [...statsMap.keys()];
      },
    };
  }
}

// Append ts to the domain's ascending list, dropping entries older than
// `dropBefore` (they can never fall inside a query window again).
function push(map: Map<string, number[]>, domain: string, ts: number, dropBefore: number): void {
  let arr = map.get(domain);
  if (!arr) map.set(domain, (arr = []));
  arr.push(ts);
  if (arr.length > 64 && arr[0] < dropBefore) {
    const cut = lowerBound(arr, dropBefore);
    if (cut > 0) arr.splice(0, cut);
  }
}
