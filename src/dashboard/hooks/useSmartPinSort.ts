import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'augur:smartPinSort';
const REORDER_KEY = 'augur:lastManualPinReorder';
const EVENT = 'augur:smart-pin-sort-changed';

// After the user manually drags pins around, smart sort backs off for this
// long. Long enough that the user gets to enjoy their arrangement; short
// enough that the row eventually adapts to time-of-day signals again.
export const MANUAL_REORDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function readEnabled(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v !== 'false';
  } catch {
    return true;
  }
}

export function useSmartPinSort(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(readEnabled);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      setEnabled(Boolean(detail));
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  const update = useCallback((next: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
    setEnabled(next);
    window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: next }));
  }, []);

  return [enabled, update];
}

export function getLastManualReorderAt(): number {
  try {
    return Number(localStorage.getItem(REORDER_KEY) ?? '0') || 0;
  } catch {
    return 0;
  }
}

export function markManualReorder(): void {
  try {
    localStorage.setItem(REORDER_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

export function isCooldownActive(now: number = Date.now()): boolean {
  return now - getLastManualReorderAt() < MANUAL_REORDER_COOLDOWN_MS;
}
