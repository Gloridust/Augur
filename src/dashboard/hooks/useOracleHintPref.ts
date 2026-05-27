import { useCallback, useEffect, useState } from 'react';

// User-facing toggle for the Oracle Hint Dynamic-Island capsule that
// appears on new-tab open when the recommend model is confident enough.
// Defaults ON. Persists in localStorage with cross-component sync via a
// custom event so flipping it in Settings takes effect on the next new
// tab without a reload.

const PREF_KEY = 'augur:oracleHintEnabled';
const PREF_EVENT = 'augur:oracle-hint-changed';

function readPref(): boolean {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export function isOracleHintEnabled(): boolean {
  return readPref();
}

export function useOracleHintPref(): [boolean, (v: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(readPref);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      setEnabled(!!detail);
    };
    window.addEventListener(PREF_EVENT, handler);
    return () => window.removeEventListener(PREF_EVENT, handler);
  }, []);
  const set = useCallback((next: boolean) => {
    try {
      localStorage.setItem(PREF_KEY, next ? 'true' : 'false');
    } catch {
      // ignore
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<boolean>(PREF_EVENT, { detail: next }));
    }
  }, []);
  return [enabled, set];
}
