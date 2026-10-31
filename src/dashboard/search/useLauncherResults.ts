import { useEffect, useMemo, useRef, useState } from 'react';
import { extractDomain } from '../../shared/db';
import { usePins } from '../hooks/usePins';
import { useTabs } from '../hooks/useTabs';
import { matchScore } from './match';

export interface LauncherHit {
  kind: 'tab' | 'pin' | 'history';
  title: string;
  url: string;
  domain: string;
  favIconUrl?: string;
  tab?: chrome.tabs.Tab;
  score: number;
}

const HISTORY_DAYS = 90;
const HISTORY_MAX = 3000;
const LIMITS = { tab: 6, pin: 3, history: 6 } as const;

// History is read once per page (when the launcher first opens) and matched
// locally: chrome.history.search's own text match is a plain substring, so it
// can't do pinyin initials or multi-term queries.
let historyCache: Promise<chrome.history.HistoryItem[]> | null = null;
function loadHistory(): Promise<chrome.history.HistoryItem[]> {
  if (!historyCache) {
    historyCache =
      typeof chrome !== 'undefined' && chrome.history?.search
        ? chrome.history
            .search({ text: '', startTime: Date.now() - HISTORY_DAYS * 864e5, maxResults: HISTORY_MAX })
            .catch(() => [])
        : Promise.resolve([]);
  }
  return historyCache;
}

// Tabs, pins and history matching `query`, best first within each kind;
// each URL appears once (an open tab beats a pin beats history).
export function useLauncherResults(query: string, active: boolean): LauncherHit[] {
  const { tabs } = useTabs();
  const { pins } = usePins();
  const [history, setHistory] = useState<chrome.history.HistoryItem[]>([]);
  const requested = useRef(false);

  useEffect(() => {
    if (!active || requested.current) return;
    requested.current = true;
    void loadHistory().then(setHistory);
  }, [active]);

  return useMemo(() => {
    const q = query.trim();
    if (!q || q.startsWith('/')) return [];
    const seen = new Set<string>();
    const pick = (hits: LauncherHit[], limit: number) =>
      hits
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true)))
        .slice(0, limit);

    const tabHits = pick(
      tabs
        .filter((t) => t.url && /^https?:/.test(t.url))
        .map((t) => {
          const domain = extractDomain(t.url);
          return {
            kind: 'tab' as const,
            title: t.title || t.url!,
            url: t.url!,
            domain,
            favIconUrl: t.favIconUrl,
            tab: t,
            // A tab you're actively using is a likelier target than one
            // parked for a week — break ties toward recently used tabs.
            score: boosted(matchScore(q, { title: t.title, url: t.url, domain }), recencyBonus(t.lastAccessed)),
          };
        }),
      LIMITS.tab,
    );
    const pinHits = pick(
      pins.map((p) => ({
        kind: 'pin' as const,
        title: p.title,
        url: p.url,
        domain: p.domain,
        favIconUrl: p.favIconUrl,
        score: matchScore(q, { title: p.title, url: p.url, domain: p.domain }),
      })),
      LIMITS.pin,
    );
    const historyHits = pick(
      history
        .filter((h) => h.url && /^https?:/.test(h.url))
        .map((h) => {
          const domain = extractDomain(h.url);
          return {
            kind: 'history' as const,
            title: h.title || h.url!,
            url: h.url!,
            domain,
            score: boosted(
              matchScore(q, { title: h.title, url: h.url, domain }),
              Math.min(10, Math.log1p(h.visitCount ?? 0) * 2) + recencyBonus(h.lastVisitTime),
            ),
          };
        }),
      LIMITS.history,
    );
    return [...tabHits, ...pinHits, ...historyHits];
  }, [query, tabs, pins, history]);
}

// Bonuses only rank among matches; they never make a non-match appear.
function boosted(score: number, bonus: number): number {
  return score > 0 ? score + bonus : 0;
}

function recencyBonus(ts: number | undefined): number {
  if (!ts) return 0;
  const hours = (Date.now() - ts) / 3.6e6;
  return Math.max(0, 8 - Math.log1p(hours) * 2);
}
