// Runs synchronously before the React bundle on every dashboard page load.
//
// The dashboard is registered as `chrome_url_overrides.newtab`. That gives
// Chrome the option to relinquish omnibox focus to the page after ⌘T (so
// OracleHint's ←/→ keyboard nav fires immediately), but it also forces
// Chrome to attach a "Augur · Customize Chrome" footer strip. The user can
// toggle this in Settings → General → Homepage:
//
//   augur:newTabMode = 'redirect' (default) → no footer, focus delayed
//   augur:newTabMode = 'override'           → footer, focus instant
//
// In 'redirect' mode we replace the URL with a query-tagged variant. That
// navigation drops the newtab role from the tab, and the footer detaches.
// We then `replaceState` back to a clean URL inside the React app so the
// query string isn't visible to the user (see main.tsx).
(function () {
  try {
    var params = new URLSearchParams(window.location.search);
    if (params.get('augurDirect') === '1') return; // already redirected past the override
    var mode = localStorage.getItem('augur:newTabMode');
    if (mode === null || mode === '') mode = 'redirect';
    if (mode !== 'redirect') return;
    // Redirect to a non-newtab URL synchronously. `replace` keeps the
    // history clean (no back-button trap on the override URL).
    window.location.replace(window.location.pathname + '?augurDirect=1');
  } catch (_) {
    // localStorage may be blocked in some contexts — fall through and let
    // the override behavior take over.
  }
})();
