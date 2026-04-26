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
  // Register the dashboard as Chrome's newtab override. This is the only way
  // for the page to claim keyboard focus from the omnibox after ⌘T — Chrome
  // only relinquishes omnibox focus to override pages, not to regular tabs
  // we redirect into. The cost is a small "Augur · Customize Chrome" strip
  // at the bottom that's part of Chrome's UI and cannot be hidden — we
  // accept it because OracleHint's keyboard nav matters more.
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
