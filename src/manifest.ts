import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: '__MSG_extName__',
  description: '__MSG_extDescription__',
  version: '0.4.2',
  default_locale: 'en',
  // Stable extension ID. Without `key`, Chrome derives the ID from the
  // install path, so reloading from a different directory creates a NEW
  // extension ID with a fresh IndexedDB — exactly how a month of training
  // history got wiped on 2026-07-05. This RSA-2048 public key (generated via
  // `npm run extension-key`; the private key was discarded) pins the ID
  // across all paths and rebuilds. The Chrome Web Store ignores this field.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1BdHHoLz5cKtQPhqMMZ+lTNbdbsKaqRcNyabe/CMBNve7yEyrSTEGRg9xQ73USvBq1aGAOAwYSdFvHYNpbqb5HpU9rvbNr/Ttscf1T9usJkytD7JzjXVbWxST0k4oG+vsLU0KkYPlNvWowZa4/3dpXVesOZUt1ahoPr01jR82vLdnBL2uEBklVZoBBgznLssiHiBfMwPExZKsIUnjj1wGcg0UHEgNw4rxhPE6VCzWZFUXZUsL029pxNHYkDOChIO9+ubcbIx3zWhdc6UcOt6X1V6s86EAUy/vLFERLT4+d8ZfENvBYYClgdZYgNNFXK6mk+PCgFqzvwjgs6+DA4QewIDAQAB',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  // Note: no `host_permissions` — `tabs` already gives us URL/title access
  // for open tabs, and we never inject scripts. Keeping this list short
  // keeps the install dialog from looking scary AND keeps CWS review fast
  // (every additional permission needs a justification in the submission
  // form).
  //
  // Each permission listed below is actively used by the codebase. If you
  // add a permission here, add a corresponding justification block to
  // doc/RELEASE.md §7 — CWS will ask, and reviewers reject unjustified
  // permission requests.
  permissions: [
    'tabs',
    'tabGroups',
    'history',
    'topSites',
    'sessions',
    'storage',
    'alarms',
    'idle',
    // Exempts our IndexedDB (all events + trained models) from Chrome's
    // best-effort storage eviction under disk pressure, and lifts the quota
    // cap. Everything Augur learns lives in IndexedDB, so durable storage is
    // the difference between "survives a low-disk day" and "silently wiped".
    // Together with the stable `key` above (which pins the extension ID),
    // this closes both known data-loss vectors.
    'unlimitedStorage',
  ],
  // We intentionally do NOT use chrome_url_overrides.newtab — registering a
  // newtab override permanently attaches Chrome's "Customize Chrome /
  // extension name" footer strip to the tab, and it cannot be hidden by
  // JS, redirect, or CSS. Once Chrome marks a tab as the newtab, the role
  // sticks regardless of subsequent same-tab navigations.
  //
  // Instead, the service worker intercepts new tabs opened to
  // chrome://newtab/ and redirects them to the dashboard URL via
  // chrome.tabs.update — the rewrite happens before Chrome assigns the
  // newtab role, so no footer ever attaches.
  //
  // Tradeoff: Chrome's anti-focus-stealing policy holds the omnibox focus
  // on ⌘T, so OracleHint's ←/→ keyboard nav only kicks in after the user
  // interacts with the page (click anywhere or press Tab). Mouse always
  // works.
  action: {
    default_title: '__MSG_extName__',
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
});
