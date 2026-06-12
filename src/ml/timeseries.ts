import { db } from '../shared/db';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WINDOW_MS = 24 * HOUR;
const BASELINE_MS = 14 * DAY;
const SESSION_MS = 30 * 60 * 1000;

// "Visit velocity" — how many open/navigate events on this domain happened
// in the last 24h compared to the trailing 14-day average per-day rate.
// Capped at 5x to keep the feature in a reasonable LR-friendly range.
//
// Returns 0..5; 1.0 means "same as baseline", >1 means trending up.
export async function visitVelocity(domain: string, now: number = Date.now()): Promise<number> {
  if (!domain) return 0;
  const since = now - BASELINE_MS;
  const events = await db.events
    .where('[domain+ts]')
    .between([domain, since], [domain, now], true, true)
    .filter((e) => e.type === 'open' || e.type === 'navigate')
    .toArray();
  if (events.length === 0) return 0;

  const recent = events.filter((e) => e.ts >= now - WINDOW_MS).length;
  const baselinePerDay = events.length / 14;
  if (baselinePerDay === 0) return 0;
  return Math.min(5, recent / baselinePerDay);
}

// "Session context" — boolean-ish: did this domain appear in the user's
// current "session" (last 30 minutes of events)? Captures the "I was just
// here" intent that hour-of-day misses.
export async function sessionContext(domain: string, now: number = Date.now()): Promise<number> {
  if (!domain) return 0;
  const since = now - SESSION_MS;
  const recent = await db.events
    .where('[domain+ts]')
    .between([domain, since], [domain, now], true, true)
    .filter((e) => e.type === 'open' || e.type === 'navigate' || e.type === 'focus')
    .first();
  return recent ? 1 : 0;
}

// ── Batched snapshot ─────────────────────────────────────────────────
// The per-domain functions above each cost one indexed IndexedDB query.
// recommendOpen scores ~80–100 candidates per call, so the per-candidate
// pattern was ~200 queries per new-tab open. TimeseriesSnapshot loads the
// last 14 days of events ONCE (a few thousand rows) and answers both
// questions from in-memory maps. Semantics match the per-domain functions
// exactly — same event-type filters, same windows, same cap.
export interface TimeseriesSnapshot {
  velocityOf(domain: string): number;
  sessionOf(domain: string): number;
  // Most recent open/navigate url+title per domain — replaces the
  // per-candidate `lastEventForDomain` query in recommend.ts for any
  // domain that appeared in the last 14 days.
  lastSeenOf(domain: string): { url?: string; title?: string } | undefined;
}

export async function buildTimeseriesSnapshot(
  now: number = Date.now(),
): Promise<TimeseriesSnapshot> {
  const since = now - BASELINE_MS;
  const events = await db.events
    .where('ts')
    .between(since, now, true, true)
    .toArray();

  const baselineCount = new Map<string, number>(); // open/navigate, 14d
  const recentCount = new Map<string, number>();   // open/navigate, 24h
  const sessionSeen = new Set<string>();           // open/navigate/focus, 30min
  const lastSeen = new Map<string, { ts: number; url?: string; title?: string }>();

  const recentCutoff = now - WINDOW_MS;
  const sessionCutoff = now - SESSION_MS;

  for (const e of events) {
    const d = e.domain;
    if (!d) continue;
    const isNav = e.type === 'open' || e.type === 'navigate';
    if (isNav) {
      baselineCount.set(d, (baselineCount.get(d) ?? 0) + 1);
      if (e.ts >= recentCutoff) {
        recentCount.set(d, (recentCount.get(d) ?? 0) + 1);
      }
      const prev = lastSeen.get(d);
      if (e.url && (!prev || e.ts > prev.ts)) {
        lastSeen.set(d, { ts: e.ts, url: e.url, title: e.title });
      }
    }
    if (
      e.ts >= sessionCutoff &&
      (isNav || e.type === 'focus')
    ) {
      sessionSeen.add(d);
    }
  }

  return {
    velocityOf(domain: string): number {
      if (!domain) return 0;
      const base = baselineCount.get(domain) ?? 0;
      if (base === 0) return 0;
      const recent = recentCount.get(domain) ?? 0;
      const baselinePerDay = base / 14;
      return Math.min(5, recent / baselinePerDay);
    },
    sessionOf(domain: string): number {
      return domain && sessionSeen.has(domain) ? 1 : 0;
    },
    lastSeenOf(domain: string) {
      const hit = lastSeen.get(domain);
      return hit ? { url: hit.url, title: hit.title } : undefined;
    },
  };
}
