import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: '__MSG_extName__',
  description: '__MSG_extDescription__',
  version: '0.1.0',
  default_locale: 'en',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  // Note: no `host_permissions` — `tabs` already gives us URL/title access for
  // open tabs, and we never inject scripts. Keeping this list short keeps the
  // install dialog from looking scary.
  permissions: [
    'tabs',
    'tabGroups',
    'history',
    'topSites',
    'sessions',
    'bookmarks',
    'storage',
    'alarms',
    'idle',
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
