import { db } from '../shared/db';
import type { TodayRecap } from '../shared/types';

export interface ActivityHeatmap {
  // [day][hour] = focus minutes during the last 30 days.
  matrix: number[][];
  dayLabels: string[];
  hourLabels: string[];
  totalMinutes: number;
}

export interface DomainTimeRow {
  domain: string;
  totalMs: number;
  visitCount: number;
}

export interface DailyRow {
  dateLabel: string;
  ts: number;
  focusMinutes: number;
}

export interface InsightsBundle {
  heatmap: ActivityHeatmap;
  topDomains: DomainTimeRow[];
  daily: DailyRow[];
  totals: {
    eventCount: number;
    distinctDomains: number;
    focusMinutesLast30d: number;
  };
}

const MS_PER_MIN = 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function buildInsights(now: number = Date.now()): Promise<InsightsBundle> {
  const since = now - 30 * MS_PER_DAY;
  const closeEvents = await db.events
    .where('[type+ts]')
    .between(['close', since], ['close', now], true, true)
    .toArray();

  const matrix: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const domainTotals = new Map<string, { totalMs: number; visitCount: number }>();
  const dailyMap = new Map<number, number>();

  for (const e of closeEvents) {
    const focusMs = e.focusMs ?? 0;
    if (focusMs <= 0) continue;
    const date = new Date(e.ts);
    const dow = date.getDay();
    const hour = date.getHours();
    matrix[dow][hour] += focusMs / MS_PER_MIN;

    const dayKey = Math.floor(e.ts / MS_PER_DAY);
    dailyMap.set(dayKey, (dailyMap.get(dayKey) ?? 0) + focusMs / MS_PER_MIN);

    if (e.domain) {
      const cur = domainTotals.get(e.domain) ?? { totalMs: 0, visitCount: 0 };
      cur.totalMs += focusMs;
      cur.visitCount += 1;
      domainTotals.set(e.domain, cur);
    }
  }

  const topDomains: DomainTimeRow[] = Array.from(domainTotals.entries())
    .map(([domain, v]) => ({ domain, ...v }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 10);

  const daily: DailyRow[] = Array.from(dailyMap.entries())
    .map(([dayKey, mins]) => {
      const ts = dayKey * MS_PER_DAY;
      return {
        ts,
        dateLabel: new Date(ts).toISOString().slice(0, 10),
        focusMinutes: Math.round(mins),
      };
    })
    .sort((a, b) => a.ts - b.ts);

  const totalMinutes = matrix.flat().reduce((s, v) => s + v, 0);
  const distinctDomains = (await db.domains.count());
  const eventCount = await db.events.count();

  return {
    heatmap: {
      matrix,
      dayLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      hourLabels: Array.from({ length: 24 }, (_, h) => `${h}`),
      totalMinutes,
    },
    topDomains,
    daily,
    totals: {
      eventCount,
      distinctDomains,
      focusMinutesLast30d: Math.round(totalMinutes),
    },
  };
}

export async function buildTodayRecap(now: number = Date.now()): Promise<TodayRecap> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startTs = start.getTime();

  const todayEvents = await db.events
    .where('ts')
    .between(startTs, now, true, true)
    .toArray();

  const domains = new Set<string>();
  const domainFocus = new Map<string, number>();
  const hourCount = new Array(24).fill(0);
  let totalFocusMs = 0;

  for (const e of todayEvents) {
    if (e.domain) domains.add(e.domain);
    if (e.type === 'open' || e.type === 'navigate' || e.type === 'focus') {
      const h = new Date(e.ts).getHours();
      hourCount[h] += 1;
    }
    if (e.type === 'close' && e.domain) {
      const fm = e.focusMs ?? 0;
      domainFocus.set(e.domain, (domainFocus.get(e.domain) ?? 0) + fm);
      totalFocusMs += fm;
    }
  }

  // tabsOpened: count tabs whose FIRST EVER event in db.events is today.
  // Robust to event-type drift: pre-fix builds didn't log 'open' on the
  // create-then-navigate path (only 'navigate'), so a literal `type==='open'`
  // count showed 0 even after lots of activity. Using "first-seen-today
  // per tabId" instead means whatever the SW happened to log first counts.
  // Synthesized history-bootstrap events have no tabId so they don't
  // pollute the per-tab map.
  const tabFirstSeen = new Map<number, number>();
  const allEvents = await db.events.orderBy('ts').toArray();
  for (const e of allEvents) {
    if (e.tabId === undefined) continue;
    if (!tabFirstSeen.has(e.tabId)) tabFirstSeen.set(e.tabId, e.ts);
  }
  let tabsOpened = 0;
  for (const ts of tabFirstSeen.values()) {
    if (ts >= startTs) tabsOpened += 1;
  }

  let topDomain: TodayRecap['topDomain'];
  for (const [d, fm] of domainFocus) {
    if (!topDomain || fm > topDomain.focusMs) topDomain = { domain: d, focusMs: fm };
  }

  let busiestHour: TodayRecap['busiestHour'];
  for (let h = 0; h < 24; h++) {
    if (!busiestHour || hourCount[h] > busiestHour.eventCount) {
      busiestHour = { hour: h, eventCount: hourCount[h] };
    }
  }
  if (busiestHour && busiestHour.eventCount === 0) busiestHour = undefined;

  return {
    tabsOpened,
    domainsVisited: domains.size,
    focusMinutes: Math.round(totalFocusMs / 60_000),
    topDomain,
    busiestHour,
  };
}
