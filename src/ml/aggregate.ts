import { db } from '../shared/db';
import type { CoOccurrence, DomainStats, TabEvent } from '../shared/types';

const VISIT_DECAY_TAU_DAYS = 14;
const VISIT_DECAY_TAU_MS = VISIT_DECAY_TAU_DAYS * 24 * 60 * 60 * 1000;
export const COOCCURRENCE_WINDOW_MS = 5 * 60 * 1000;
const COOCCURRENCE_DECAY_DAYS = 30;
const COOCCURRENCE_DECAY_MS = COOCCURRENCE_DECAY_DAYS * 24 * 60 * 60 * 1000;
const QUICK_CLOSE_MS = 8_000;

// Frecency as of `now`: the stored value is exact as of `decayAt`, so decay it
// the rest of the way. (The old scheme added +1 per visit and decayed by
// "time since last visit" every 6 h, so an active domain's value grew without
// bound and only shrank once you stopped visiting — not a frecency.)
export function frecencyAt(s: DomainStats, now: number): number {
  const anchor = s.decayAt ?? s.lastVisit ?? now;
  return s.visitsDecay * Math.exp(-Math.max(0, now - anchor) / VISIT_DECAY_TAU_MS);
}

// Co-occurrence counts decay with τ = 30 d, applied exactly at READ time from
// the pair's lastSeen (the stored count is exact as of lastSeen). Previously
// a 6-hourly job multiplied by exp(−(now − lastSeen)/τ) again and again, so a
// count depended on how many times the alarm had fired.
export function pairCountAt(p: CoOccurrence, now: number): number {
  return p.count * Math.exp(-Math.max(0, now - p.lastSeen) / COOCCURRENCE_DECAY_MS);
}

export function bumpPair(p: CoOccurrence, ts: number): void {
  p.count = pairCountAt(p, ts) + 1;
  p.lastSeen = ts;
}

export function emptyStats(domain: string, now: number): DomainStats {
  return {
    domain,
    visitCount: 0,
    visitsDecay: 0,
    totalFocusMs: 0,
    avgFocusMs: 0,
    closeWithoutFocusCount: 0,
    closeQuickCount: 0,
    hourDist: new Array(24).fill(0),
    dowDist: new Array(7).fill(0),
    lastVisit: 0,
    updatedAt: now,
  };
}

export function pairKey(a: string, b: string): { pair: string; a: string; b: string } {
  const [x, y] = a < b ? [a, b] : [b, a];
  return { pair: `${x}::${y}`, a: x, b: y };
}

// A "visit" is an ARRIVAL on a domain: a tab opening on it, or a tab
// navigating to it from a different domain. Same-domain navigations (SPA
// route changes — 86% of navigates in a real trace) are not visits; counting
// them made frecency measure how chatty a web app's router is, and deflated
// avgFocusMs (= focus / visits) for exactly those apps.
export function applyVisit(s: DomainStats, event: TabEvent): void {
  s.visitCount += 1;
  s.visitsDecay = frecencyAt(s, event.ts) + 1;
  s.decayAt = event.ts;
  const h = event.hourOfDay ?? new Date(event.ts).getHours();
  const d = event.dayOfWeek ?? new Date(event.ts).getDay();
  s.hourDist[h] = (s.hourDist[h] ?? 0) + 1;
  s.dowDist[d] = (s.dowDist[d] ?? 0) + 1;
  s.lastVisit = event.ts;
}

export function applyClose(s: DomainStats, event: TabEvent): void {
  const focusMs = event.focusMs ?? 0;
  s.totalFocusMs += focusMs;
  s.avgFocusMs = s.totalFocusMs / Math.max(s.visitCount, 1);
  if (focusMs <= 0) s.closeWithoutFocusCount += 1;
  if ((event.durationMs ?? 0) <= QUICK_CLOSE_MS) s.closeQuickCount += 1;
}

// Incremental update at event time. `arrival` = this open/navigate brought
// the tab to a new domain (callers know the tab's previous domain).
export async function updateOnEvent(event: TabEvent, arrival = true): Promise<void> {
  if (!event.domain) return;
  const isVisit = (event.type === 'open' || event.type === 'navigate') && arrival;
  if (!isVisit && event.type !== 'close') return;
  const existing = (await db.domains.get(event.domain)) ?? emptyStats(event.domain, event.ts);
  if (isVisit) applyVisit(existing, event);
  else applyClose(existing, event);
  existing.updatedAt = event.ts;
  await db.domains.put(existing);
}

// Co-occurrence increment: any time a tab opens, find tabs opened in the last
// 5 minutes (other domains) and bump pair counts.
export async function updateCooccurrenceForOpen(
  domain: string,
  ts: number,
): Promise<void> {
  if (!domain) return;
  const since = ts - COOCCURRENCE_WINDOW_MS;
  const recent = await db.events
    .where('ts')
    .between(since, ts, true, true)
    .filter((e) => (e.type === 'open' || e.type === 'navigate') && !!e.domain && e.domain !== domain)
    .toArray();
  const seen = new Set<string>();
  for (const e of recent) {
    if (!e.domain || seen.has(e.domain)) continue;
    seen.add(e.domain);
    const k = pairKey(domain, e.domain);
    const existing = (await db.cooccurrence.get(k.pair)) ?? { ...k, count: 0, lastSeen: ts };
    bumpPair(existing, ts);
    await db.cooccurrence.put(existing);
  }
}

// Nightly batch: re-compute decayed visit counts and prune dead pairs.
export async function decayAndPrune(now: number): Promise<void> {
  const all = await db.domains.toArray();
  for (const d of all) {
    d.visitsDecay = frecencyAt(d, now);
    d.decayAt = now;
    d.updatedAt = now;
  }
  await db.domains.bulkPut(all);
  // Pairs aren't re-decayed (decay is applied at read time); just drop the
  // ones that have faded out.
  const pairs = await db.cooccurrence.toArray();
  const dead = pairs.filter((p) => pairCountAt(p, now) < 0.1).map((p) => p.pair);
  if (dead.length) await db.cooccurrence.bulkDelete(dead);
}

// Full rebuild from events — used on first run, after the v5 de-duplication
// migration, after a data import, or to recover from drift.
//
// One in-memory pass + two bulkPuts. (The old version awaited a get+put per
// event plus a window query and per-pair get/put per open/navigate inside one
// transaction — ~50k sequential round-trips on 16k events.) Arrival detection
// follows each tab's previous domain, exactly like the live path; visitsDecay
// is the proper frecency Σ exp(−age/τ) rather than an undecayed count.
// Replays the live aggregation rules over an ordered event stream, in memory.
// The single implementation behind both the full rebuild and the
// point-in-time aggregates used for training/evaluation (./pit), so the two
// can never count visits or pairs differently from each other or from the
// live per-event path (updateOnEvent + updateCooccurrenceForOpen).
export class AggregateReplayer {
  readonly stats = new Map<string, DomainStats>();
  readonly pairs = new Map<string, CoOccurrence>();
  private lastDomainByTab = new Map<number, string>();
  private window: Array<{ domain: string; ts: number }> = []; // open/navigate, last 5 min

  private statFor(domain: string, ts: number): DomainStats {
    let s = this.stats.get(domain);
    if (!s) this.stats.set(domain, (s = emptyStats(domain, ts)));
    return s;
  }

  apply(e: TabEvent): void {
    if (!e.domain) return;
    if (e.type === 'open' || e.type === 'navigate') {
      const prevDomain = e.tabId !== undefined ? this.lastDomainByTab.get(e.tabId) : undefined;
      const arrival = e.type === 'open' || prevDomain !== e.domain;
      if (e.tabId !== undefined) this.lastDomainByTab.set(e.tabId, e.domain);
      while (this.window.length && e.ts - this.window[0].ts > COOCCURRENCE_WINDOW_MS) {
        this.window.shift();
      }
      if (arrival) {
        applyVisit(this.statFor(e.domain, e.ts), e);
        const seen = new Set<string>();
        for (const w of this.window) {
          if (w.domain === e.domain || seen.has(w.domain)) continue;
          seen.add(w.domain);
          const k = pairKey(e.domain, w.domain);
          const p = this.pairs.get(k.pair) ?? { ...k, count: 0, lastSeen: e.ts };
          bumpPair(p, e.ts);
          this.pairs.set(k.pair, p);
        }
      }
      this.window.push({ domain: e.domain, ts: e.ts });
    } else if (e.type === 'close') {
      applyClose(this.statFor(e.domain, e.ts), e);
      if (e.tabId !== undefined) this.lastDomainByTab.delete(e.tabId);
    }
  }
}

export async function rebuildFromEvents(now: number = Date.now()): Promise<{
  domains: number;
  pairs: number;
}> {
  const events = await db.events.orderBy('ts').toArray();
  const r = new AggregateReplayer();
  for (const e of events) r.apply(e);
  const stats = r.stats;
  const pairs = r.pairs;
  for (const s of stats.values()) s.updatedAt = now;

  await db.transaction('rw', [db.domains, db.cooccurrence], async () => {
    await db.domains.clear();
    await db.cooccurrence.clear();
    await db.domains.bulkPut([...stats.values()]);
    await db.cooccurrence.bulkPut([...pairs.values()]);
  });
  return { domains: stats.size, pairs: pairs.size };
}

export async function getDomainStats(domain: string): Promise<DomainStats | undefined> {
  return db.domains.get(domain);
}

export async function getTopDomainsByFrecency(
  limit: number,
  now: number = Date.now(),
): Promise<DomainStats[]> {
  return topByFrecency(await db.domains.toArray(), limit, now);
}

export function topByFrecency(all: Iterable<DomainStats>, limit: number, now: number): DomainStats[] {
  return [...all]
    .map((s) => ({ s, f: frecencyAt(s, now) }))
    .sort((a, b) => b.f - a.f)
    .slice(0, limit)
    .map((x) => x.s);
}

export async function getCooccurrenceSum(domain: string, partners: string[]): Promise<number> {
  if (!domain || partners.length === 0) return 0;
  let sum = 0;
  for (const p of partners) {
    if (p === domain) continue;
    const k = pairKey(domain, p);
    const row = await db.cooccurrence.get(k.pair);
    if (row) sum += pairCountAt(row, Date.now());
  }
  return sum;
}
