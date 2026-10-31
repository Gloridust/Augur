import { useCallback, useEffect, useState } from 'react';

// Zen mode: the new-tab page shrinks to the brand and the search launcher.
// Per-device preference (localStorage), mirrored across open dashboards.
const KEY = 'augur:zen';
const EVENT = 'augur:zen-changed';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setZen(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* private window: session-only */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
}

export function useZenMode(): [boolean, (on: boolean) => void] {
  const [zen, setLocal] = useState(read);
  useEffect(() => {
    const onLocal = (e: Event) => setLocal(Boolean((e as CustomEvent<boolean>).detail));
    const onOther = (e: StorageEvent) => {
      if (e.key === KEY) setLocal(e.newValue === '1');
    };
    window.addEventListener(EVENT, onLocal);
    window.addEventListener('storage', onOther);
    return () => {
      window.removeEventListener(EVENT, onLocal);
      window.removeEventListener('storage', onOther);
    };
  }, []);
  return [zen, useCallback((on: boolean) => setZen(on), [])];
}
