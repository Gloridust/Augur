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
    'identity.email',
  ],
  // Tiny stub that redirects to the real dashboard URL. We do this so that
  // the "Customize Chrome / extension name" strip Chrome attaches to the
  // newtab override does NOT follow us to the dashboard. The user sees a
  // sub-100ms loading flash, then lands on a clean extension page.
  chrome_url_overrides: {
    newtab: 'newtab.html',
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
