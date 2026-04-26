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

// Incremental update at event time. Cheap; runs in service-worker hot path.
export async function updateOnEvent(event: TabEvent): Promise<void> {
  if (!event.domain) return;
  const now = event.ts;
  const existing = (await db.domains.get(event.domain)) ?? emptyStats(event.domain, now);

  switch (event.type) {
    case 'open':
    case 'navigate': {
      existing.visitCount += 1;
      existing.visitsDecay += 1;
      const h = event.hourOfDay ?? 0;
      const d = event.dayOfWeek ?? 0;
      existing.hourDist[h] = (existing.hourDist[h] ?? 0) + 1;
      existing.dowDist[d] = (existing.dowDist[d] ?? 0) + 1;
      existing.lastVisit = now;
      break;
    }
    case 'close': {
      const focusMs = event.focusMs ?? 0;
      existing.totalFocusMs += focusMs;
      const denom = Math.max(existing.visitCount, 1);
      existing.avgFocusMs = existing.totalFocusMs / denom;
      if (focusMs <= 0) existing.closeWithoutFocusCount += 1;
      if ((event.durationMs ?? 0) <= QUICK_CLOSE_MS) existing.closeQuickCount += 1;
      break;
    }
    default:
      return;
  }
  existing.updatedAt = now;
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

// Full rebuild from events — used on first run, or to recover from drift.
export async function rebuildFromEvents(): Promise<void> {
  await db.transaction('rw', [db.domains, db.cooccurrence, db.events], async () => {
    await db.domains.clear();
    await db.cooccurrence.clear();
    const events = await db.events.orderBy('ts').toArray();
    for (const e of events) {
      await updateOnEvent(e);
      if ((e.type === 'open' || e.type === 'navigate') && e.domain) {
        await updateCooccurrenceForOpen(e.domain, e.ts);
      }
    }
  });
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
