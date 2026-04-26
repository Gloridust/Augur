import { useEffect, useState } from 'react';

// Pull a friendly first-name out of the user's email local-part. We do not
// have access to the user's display name without OAuth, so this is a best
// effort: turn "ethan.doe@example.com" → "Ethan", "first_last@..." → "First".
function nameFromEmail(email: string | undefined): string | null {
  if (!email) return null;
  const local = email.split('@')[0];
  if (!local) return null;
  const first = local.split(/[._-]/)[0] ?? local;
  if (!first) return null;
  // Skip purely numeric handles like "12345@gmail" — capitalizing is silly.
  if (/^\d+$/.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

export function useUserName(): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome?.identity?.getProfileUserInfo) {
      return;
    }
    try {
      chrome.identity.getProfileUserInfo((info) => {
        if (chrome.runtime.lastError) return;
        if (info?.email) setName(nameFromEmail(info.email));
      });
    } catch {
      // identity API may be unavailable on locked-down browsers; ignore.
    }
  }, []);

  return name;
}
