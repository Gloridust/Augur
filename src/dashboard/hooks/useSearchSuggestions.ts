import { useEffect, useState } from 'react';

// Google's suggest endpoint (`suggestqueries.google.com`) returns
// `Access-Control-Allow-Origin: *`, so we can call it from an extension
// page without declaring host_permissions. We use it regardless of the
// user's chosen search engine — Bing's suggest endpoint isn't CORS-friendly,
// and Google's suggestions are good enough as a generic source. The actual
// search submission still respects the chosen engine.

export function useSearchSuggestions(query: string): string[] {
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`;
        const resp = await fetch(url, { signal: ctrl.signal });
        if (!resp.ok) return;
        const data = (await resp.json()) as [string, string[]];
        if (Array.isArray(data) && Array.isArray(data[1])) {
          setSuggestions(data[1].slice(0, 8));
        }
      } catch {
        // Network / CORS / abort — fail silently. The user can still submit
        // the raw query, suggestions are just a nicety.
      }
    }, 180);

    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  return suggestions;
}
