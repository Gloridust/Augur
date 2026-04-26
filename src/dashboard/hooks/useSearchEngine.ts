import { useCallback, useEffect, useState } from 'react';

export type SearchEngine = 'google' | 'bing';

const STORAGE_KEY = 'augur:searchEngine';
const EVENT = 'augur:search-engine-changed';

function readStored(): SearchEngine {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'bing' ? 'bing' : 'google';
  } catch {
    return 'google';
  }
}

export function useSearchEngine(): [SearchEngine, (next: SearchEngine) => void] {
  const [engine, setEngine] = useState<SearchEngine>(readStored);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SearchEngine>).detail;
      if (detail) setEngine(detail);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  const update = useCallback((next: SearchEngine) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    setEngine(next);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  }, []);

  return [engine, update];
}

export function searchUrlFor(engine: SearchEngine, query: string): string {
  const q = encodeURIComponent(query);
  return engine === 'bing'
    ? `https://www.bing.com/search?q=${q}`
    : `https://www.google.com/search?q=${q}`;
}
