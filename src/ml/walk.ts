// Chronological walk over the event log with point-in-time state — the
// offline twin of the service worker's live path. Replay, the forest trainer
// and the evaluator all walk with this, so they agree with each other and
// with live training on:
//   - which opens are "switch" training/test points (arrival on a new domain,
//     not the focused domain, not seen in the last 2 min, not already open in
//     another tab — the live rules; serving never suggests an open domain,
//     so an open domain is not a target either),
//   - the focus history, session start and open-tab domains at each point,
//   - and, via PointInTimeAggregates, the aggregates as of each point.
//
// onEvent is called for EVERY event, BEFORE the point-in-time state advances
// past it, with a SwitchPoint when the event qualifies.

import type { TabEvent } from '../shared/types';
import type { PointInTimeAggregates } from './pit';

export const RECENT_SEEN_MS = 2 * 60 * 1000;
export const SESSION_GAP_MS = 30 * 60 * 1000;
const FOCUS_HISTORY_MAX = 8;

export interface SwitchPoint {
  event: TabEvent;
  focusHistory: string[];
  focusedDomain?: string;
  sessionStartTs: number;
  recentlyFocused: string[];
  // Domains open in OTHER tabs (reconstructed from the log), as live
  // serving/training get from the tab state map.
  openDomains: string[];
}

export async function walkEvents(
  events: TabEvent[],
  pit: PointInTimeAggregates | null, // null = a cheap selection pass
  onEvent: (e: TabEvent, point: SwitchPoint | null) => Promise<void> | void,
): Promise<void> {
  const focusHistory: string[] = [];
  const recent: Array<{ domain: string; ts: number }> = [];
  // Current domain of every tab the log has shown us; doubles as the
  // open-tab set (a tab leaves it on close).
  const lastDomainByTab = new Map<number, string>();
  let sessionStartTs = events[0]?.ts ?? 0;
  let lastTs = sessionStartTs;

  for (const e of events) {
    if (e.ts - lastTs > SESSION_GAP_MS) sessionStartTs = e.ts;
    lastTs = e.ts;
    while (recent.length && e.ts - recent[0].ts > RECENT_SEEN_MS) recent.shift();

    let point: SwitchPoint | null = null;
    const openLike = e.type === 'open' || e.type === 'navigate';
    if (openLike && e.domain && e.tabId !== undefined) {
      const arrival = e.type === 'open' || lastDomainByTab.get(e.tabId) !== e.domain;
      const isBootstrap = (e.meta as Record<string, unknown> | undefined)?.source === 'history-bootstrap';
      const focusedDomain = focusHistory[focusHistory.length - 1];
      const recentlyFocused = recent.map((r) => r.domain);
      if (
        arrival &&
        !isBootstrap &&
        !e.domain.startsWith('chrome') &&
        e.domain !== focusedDomain &&
        !recentlyFocused.includes(e.domain)
      ) {
        const openDomains = new Set<string>();
        for (const [tab, d] of lastDomainByTab) if (tab !== e.tabId) openDomains.add(d);
        if (!openDomains.has(e.domain)) {
          point = {
            event: e,
            focusHistory: [...focusHistory],
            focusedDomain,
            sessionStartTs,
            recentlyFocused,
            openDomains: [...openDomains],
          };
        }
      }
      lastDomainByTab.set(e.tabId, e.domain);
    } else if (e.type === 'close' && e.tabId !== undefined) {
      lastDomainByTab.delete(e.tabId);
    } else if (e.type === 'focus' && e.tabId !== undefined && e.domain) {
      // Tabs opened before logging began first show up on focus.
      lastDomainByTab.set(e.tabId, e.domain);
    }

    await onEvent(e, point);
    pit?.advance(e);

    if (e.domain && (openLike || e.type === 'focus')) recent.push({ domain: e.domain, ts: e.ts });
    if (e.type === 'focus' && e.domain && e.tabId !== undefined) {
      if (focusHistory[focusHistory.length - 1] !== e.domain) {
        focusHistory.push(e.domain);
        if (focusHistory.length > FOCUS_HISTORY_MAX) focusHistory.shift();
      }
    }
  }
}
