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
  // We register the dashboard as Chrome's newtab override so the user can
  // (optionally) keep keyboard focus on the page after ⌘T — that's the only
  // configuration in which Chrome relinquishes omnibox focus to the override
  // page. The cost: an "Augur · Customize Chrome" footer strip Chrome
  // attaches to override pages, with no API to hide it.
  //
  // To let the user opt out of that footer, `public/newtab-router.js` runs
  // synchronously before the React bundle. It reads `augur:newTabMode` from
  // localStorage and, if set to 'redirect' (the default), navigates the tab
  // to a non-override URL — Chrome then drops the newtab role and the
  // footer detaches. The cost: focus stays in the omnibox until the user
  // interacts with the page.
  //
  // The toggle lives in Settings → General → Homepage.
  chrome_url_overrides: {
    newtab: 'src/dashboard/index.html',
  },
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
