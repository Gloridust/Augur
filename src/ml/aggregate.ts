import { db } from '../shared/db';
import type { CoOccurrence, DomainStats, TabEvent } from '../shared/types';

const VISIT_DECAY_TAU_DAYS = 14;
const VISIT_DECAY_TAU_MS = VISIT_DECAY_TAU_DAYS * 24 * 60 * 60 * 1000;
const COOCCURRENCE_WINDOW_MS = 5 * 60 * 1000;
const COOCCURRENCE_DECAY_DAYS = 30;
const COOCCURRENCE_DECAY_MS = COOCCURRENCE_DECAY_DAYS * 24 * 60 * 60 * 1000;
const QUICK_CLOSE_MS = 8_000;

function emptyStats(domain: string, now: number): DomainStats {
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

function pairKey(a: string, b: string): { pair: string; a: string; b: string } {
  const [x, y] = a < b ? [a, b] : [b, a];
  return { pair: `${x}::${y}`, a: x, b: y };
}

// A "visit" is an ARRIVAL on a domain: a tab opening on it, or a tab
// navigating to it from a different domain. Same-domain navigations (SPA
// route changes — 86% of navigates in a real trace) are not visits; counting
// them made frecency measure how chatty a web app's router is, and deflated
// avgFocusMs (= focus / visits) for exactly those apps.
function applyVisit(s: DomainStats, event: TabEvent): void {
  s.visitCount += 1;
  s.visitsDecay += 1;
  const h = event.hourOfDay ?? new Date(event.ts).getHours();
  const d = event.dayOfWeek ?? new Date(event.ts).getDay();
  s.hourDist[h] = (s.hourDist[h] ?? 0) + 1;
  s.dowDist[d] = (s.dowDist[d] ?? 0) + 1;
  s.lastVisit = event.ts;
}

function applyClose(s: DomainStats, event: TabEvent): void {
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
    const existing = await db.cooccurrence.get(k.pair);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = ts;
      await db.cooccurrence.put(existing);
    } else {
      const fresh: CoOccurrence = { ...k, count: 1, lastSeen: ts };
      await db.cooccurrence.put(fresh);
    }
  }
}

// Nightly batch: re-compute decayed visit counts and prune dead pairs.
export async function decayAndPrune(now: number): Promise<void> {
  const all = await db.domains.toArray();
  for (const d of all) {
    const ageMs = Math.max(0, now - d.lastVisit);
    const decay = Math.exp(-ageMs / VISIT_DECAY_TAU_MS);
    d.visitsDecay = d.visitsDecay * decay;
    d.updatedAt = now;
    await db.domains.put(d);
  }
  const pairs = await db.cooccurrence.toArray();
  for (const p of pairs) {
    const ageMs = Math.max(0, now - p.lastSeen);
    if (ageMs > COOCCURRENCE_DECAY_MS && p.count <= 1) {
      await db.cooccurrence.delete(p.pair);
      continue;
    }
    p.count = p.count * Math.exp(-ageMs / COOCCURRENCE_DECAY_MS);
    if (p.count < 0.1) {
      await db.cooccurrence.delete(p.pair);
    } else {
      await db.cooccurrence.put(p);
    }
  }
}

// Full rebuild from events — used on first run, after the v5 de-duplication
// migration, after a data import, or to recover from drift.
//
// One in-memory pass + two bulkPuts. (The old version awaited a get+put per
// event plus a window query and per-pair get/put per open/navigate inside one
// transaction — ~50k sequential round-trips on 16k events.) Arrival detection
// follows each tab's previous domain, exactly like the live path; visitsDecay
// is the proper frecency Σ exp(−age/τ) rather than an undecayed count.
export async function rebuildFromEvents(now: number = Date.now()): Promise<{
  domains: number;
  pairs: number;
}> {
  const events = await db.events.orderBy('ts').toArray();
  const stats = new Map<string, DomainStats>();
  const pairs = new Map<string, CoOccurrence>();
  const lastDomainByTab = new Map<number, string>();
  const window: Array<{ domain: string; ts: number }> = []; // open/navigate in last 5 min

  const statFor = (domain: string, ts: number) => {
    let s = stats.get(domain);
    if (!s) stats.set(domain, (s = emptyStats(domain, ts)));
    return s;
  };

  for (const e of events) {
    if (!e.domain) continue;
    if (e.type === 'open' || e.type === 'navigate') {
      const prevDomain = e.tabId !== undefined ? lastDomainByTab.get(e.tabId) : undefined;
      const arrival = e.type === 'open' || prevDomain !== e.domain;
      if (e.tabId !== undefined) lastDomainByTab.set(e.tabId, e.domain);
      while (window.length && e.ts - window[0].ts > COOCCURRENCE_WINDOW_MS) window.shift();
      if (arrival) {
        const s = statFor(e.domain, e.ts);
        applyVisit(s, e);
        s.visitsDecay += Math.exp(-Math.max(0, now - e.ts) / VISIT_DECAY_TAU_MS) - 1;
        const seen = new Set<string>();
        for (const w of window) {
          if (w.domain === e.domain || seen.has(w.domain)) continue;
          seen.add(w.domain);
          const k = pairKey(e.domain, w.domain);
          const p = pairs.get(k.pair) ?? { ...k, count: 0, lastSeen: e.ts };
          p.count += 1;
          p.lastSeen = e.ts;
          pairs.set(k.pair, p);
        }
      }
      window.push({ domain: e.domain, ts: e.ts });
    } else if (e.type === 'close') {
      applyClose(statFor(e.domain, e.ts), e);
      if (e.tabId !== undefined) lastDomainByTab.delete(e.tabId);
    }
  }
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

export async function getTopDomainsByFrecency(limit: number): Promise<DomainStats[]> {
  const all = await db.domains.toArray();
  return all.sort((a, b) => b.visitsDecay - a.visitsDecay).slice(0, limit);
}

export async function getCooccurrenceSum(domain: string, partners: string[]): Promise<number> {
  if (!domain || partners.length === 0) return 0;
  let sum = 0;
  for (const p of partners) {
    if (p === domain) continue;
    const k = pairKey(domain, p);
    const row = await db.cooccurrence.get(k.pair);
    if (row) sum += row.count;
  }
  return sum;
}
