import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'augur:recentSearches';
const EVENT = 'augur:recent-searches-changed';
const MAX_RECENT = 8;

function read(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function write(list: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent<string[]>(EVENT, { detail: list }));
}

export function useRecentSearches(): {
  recent: string[];
  add: (q: string) => void;
  remove: (q: string) => void;
  clear: () => void;
} {
  const [recent, setRecent] = useState<string[]>(read);

  useEffect(() => {
    const handler = (e: Event) => {
      const next = (e as CustomEvent<string[]>).detail;
      if (next) setRecent(next);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  const add = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setRecent((prev) => {
      const next = [trimmed, ...prev.filter((x) => x !== trimmed)].slice(0, MAX_RECENT);
      write(next);
      return next;
    });
  }, []);

  const remove = useCallback((q: string) => {
    setRecent((prev) => {
      const next = prev.filter((x) => x !== q);
      write(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setRecent([]);
    write([]);
  }, []);

  return { recent, add, remove, clear };
}
