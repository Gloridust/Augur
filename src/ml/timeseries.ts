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
