import { useCallback, useEffect, useState } from 'react';

// User-provided display name. Stored in localStorage rather than read from
// the Chrome account, because:
//   1) The identity.email permission is scary on the install dialog and many
//      users say "no".
//   2) The user might want to see "Ethan" even when their work account email
//      starts with a number, or when they're signed out.
// Setting the name dispatches a custom event so any subscribed component
// (like Greeting) re-renders without prop drilling.

const STORAGE_KEY = 'augur:userName';
const EVENT = 'augur:user-name-changed';

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function useUserName(): string {
  const [name, setName] = useState<string>(readStored);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      setName(detail ?? '');
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  return name;
}

export function setUserName(name: string): void {
  const trimmed = name.trim();
  try {
    if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable; let the event still fire.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: trimmed }));
  }
}

export function getUserName(): string {
  return readStored();
}

// A useState-style helper for components that both read and write the value.
export function useUserNameField(): [string, (next: string) => void] {
  const stored = useUserName();
  const set = useCallback((next: string) => setUserName(next), []);
  return [stored, set];
}
