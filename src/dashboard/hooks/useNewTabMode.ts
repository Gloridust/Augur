import { useCallback, useEffect, useState } from 'react';

// Controls how the dashboard handles being loaded as Chrome's newtab override.
//
//   'redirect' (default) — public/newtab-router.js redirects the page off
//                          the override URL on every load. Chrome then drops
//                          the newtab role from the tab and the
//                          "Customize Chrome" footer detaches. The cost:
//                          omnibox keeps focus after ⌘T, so OracleHint's
//                          ←/→ keyboard nav only kicks in once the user
//                          interacts with the page.
//
//   'override'           — router does nothing. The page loads inside the
//                          newtab-override context, Chrome attaches the
//                          footer, and the page can claim keyboard focus
//                          immediately.
//
// The setting only takes effect on subsequent ⌘T — we don't reload the
// current dashboard tab on toggle, since that would be jarring.

export type NewTabMode = 'redirect' | 'override';

const STORAGE_KEY = 'augur:newTabMode';
const EVENT = 'augur:newtab-mode-changed';
const DEFAULT: NewTabMode = 'redirect';

function readStored(): NewTabMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'override' ? 'override' : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function useNewTabMode(): [NewTabMode, (next: NewTabMode) => void] {
  const [mode, setMode] = useState<NewTabMode>(readStored);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NewTabMode>).detail;
      if (detail === 'redirect' || detail === 'override') setMode(detail);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  const set = useCallback((next: NewTabMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<NewTabMode>(EVENT, { detail: next }));
    }
  }, []);

  return [mode, set];
}
