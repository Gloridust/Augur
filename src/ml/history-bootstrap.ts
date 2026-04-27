import { db, extractDomain } from '../shared/db';
import type { TabEvent } from '../shared/types';
import { rebuildFromEvents } from './aggregate';

// One-time bootstrap that seeds db.events from the user's existing browser
// history when Augur is first installed. Without this, a fresh install
// stares at an empty model for days while live tab events accumulate; with
// it, the recommendation + cleanup heads have a real distribution to learn
// from on day one.
//
// Strategy:
//   1. chrome.history.search() pulls last 30 days, up to 5000 URLs.
//   2. Sort by visitCount desc.
//   3. For the top 200 (where time-of-day distribution actually matters),
//      call chrome.history.getVisits() to fetch real per-visit timestamps.
//   4. For the rest, synthesize one event at lastVisitTime — preserves
//      the URL + domain signal even if we lose intra-URL time spread.
//   5. Bulk-insert into db.events, then rebuildFromEvents() to populate
//      domain stats and co-occurrence from the seeded events.
//   6. Mark `kv['historyBootstrappedAt']` so we don't re-run on update.

const LOOKBACK_DAYS = 30;
const MAX_HISTORY_ITEMS = 5000;
const TOP_N_DETAILED = 200;
const MAX_VISITS_PER_URL = 100;
const HISTORY_BOOTSTRAP_KEY = 'historyBootstrappedAt';
const BOOTSTRAP_TAG = 'history-bootstrap';

export interface BootstrapResult {
  events: number;
  domains: number;
  // True if the bootstrap was skipped (already done, no API access, or
  // history empty).
  skipped: boolean;
  reason?: string;
}

function isTrackableUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith('chrome://')) return false;
  if (url.startsWith('chrome-extension://')) return false;
  if (url.startsWith('edge://') || url.startsWith('about:')) return false;
  if (url.startsWith('file://')) return false;
  if (url.startsWith('javascript:')) return false;
  return true;
}

export async function isHistoryBootstrapped(): Promise<boolean> {
  const row = await db.kv.get(HISTORY_BOOTSTRAP_KEY);
  return row?.value !== undefined && row.value !== null;
}

async function deleteBootstrapEvents(): Promise<number> {
  const all = await db.events.toArray();
  const ids = all
    .filter((e) => {
      const meta = e.meta as Record<string, unknown> | undefined;
      return meta?.source === BOOTSTRAP_TAG;
    })
    .map((e) => e.id)
    .filter((id): id is number => id !== undefined);
  if (ids.length > 0) await db.events.bulkDelete(ids);
  return ids.length;
}

export async function bootstrapFromHistory(
  opts: { force?: boolean } = {},
): Promise<BootstrapResult> {
  if (!opts.force && (await isHistoryBootstrapped())) {
    return { events: 0, domains: 0, skipped: true, reason: 'already-bootstrapped' };
  }
  if (!chrome.history?.search) {
    return { events: 0, domains: 0, skipped: true, reason: 'no-history-api' };
  }

  // Re-seed clears prior bootstrap-tagged events so we don't accumulate
  // duplicates. Live tab events are untouched.
  if (opts.force) {
    await deleteBootstrapEvents();
  }

  const now = Date.now();
  const startTime = now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  let items: chrome.history.HistoryItem[];
  try {
    items = await chrome.history.search({
      text: '',
      startTime,
      maxResults: MAX_HISTORY_ITEMS,
    });
  } catch (err) {
    return {
      events: 0,
      domains: 0,
      skipped: true,
      reason: `history-search-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const tracked = items
    .filter((i) => isTrackableUrl(i.url))
    .sort((a, b) => (b.visitCount ?? 0) - (a.visitCount ?? 0));

  const events: TabEvent[] = [];
  const seenDomains = new Set<string>();

  // Top N: use getVisits for accurate per-visit timestamps. This gives the
  // model a real time-of-day distribution to learn from.
  const topN = tracked.slice(0, TOP_N_DETAILED);
  for (const item of topN) {
    const url = item.url ?? '';
    const domain = extractDomain(url);
    if (!domain) continue;
    seenDomains.add(domain);
    let visits: chrome.history.VisitItem[] = [];
    try {
      visits = await chrome.history.getVisits({ url });
    } catch {
      // skip — fall through to lastVisitTime path
    }
    const recent = visits
      .filter((v) => v.visitTime !== undefined && v.visitTime >= startTime)
      .slice(-MAX_VISITS_PER_URL);
    if (recent.length === 0) {
      const ts = item.lastVisitTime ?? now;
      events.push(makeEvent(ts, url, domain, item.title));
      continue;
    }
    for (const v of recent) {
      const ts = v.visitTime ?? item.lastVisitTime ?? now;
      events.push(makeEvent(ts, url, domain, item.title));
    }
  }

  // Long tail: just one event per URL at lastVisitTime. Preserves domain
  // frequency without thousands of getVisits() round-trips.
  const tail = tracked.slice(TOP_N_DETAILED);
  for (const item of tail) {
    const url = item.url ?? '';
    const domain = extractDomain(url);
    if (!domain) continue;
    seenDomains.add(domain);
    const ts = item.lastVisitTime ?? now;
    events.push(makeEvent(ts, url, domain, item.title));
  }

  if (events.length > 0) {
    await db.events.bulkAdd(events);
    // Rebuilds domain stats + co-occurrence from the entire events table
    // (so it sees both seeded and any live events).
    await rebuildFromEvents();
  }

  await db.kv.put({ key: HISTORY_BOOTSTRAP_KEY, value: now, updatedAt: now });

  return { events: events.length, domains: seenDomains.size, skipped: false };
}

function makeEvent(
  ts: number,
  url: string,
  domain: string,
  title: string | undefined,
): TabEvent {
  const d = new Date(ts);
  return {
    ts,
    type: 'navigate',
    url,
    domain,
    title,
    hourOfDay: d.getHours(),
    dayOfWeek: d.getDay(),
    openedFrom: 'unknown',
    meta: { source: BOOTSTRAP_TAG },
  };
}
