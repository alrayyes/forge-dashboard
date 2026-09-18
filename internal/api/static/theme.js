// Applies whatever theme was last chosen — in Settings, the only place
// it's ever set (#352) — before first paint, so there's no flash of the
// wrong theme. Loaded synchronously in <head> on every page.
//
// Reads the same forge-board-theme cookie $lib/theme.ts writes — a
// cookie, not localStorage, because it rides along on every request
// (surviving a login on a fresh tab the same way a session cookie does)
// and because this file and the SvelteKit app have no shared module
// state to keep a single source of truth in otherwise. Every
// authenticated page also reconciles this cookie against the server on
// load (syncThemeFromServer) so a theme picked on one device shows up
// on another; this script only ever applies whatever the cookie already
// has, before that reconciliation has a chance to run.
(() => {
  var COOKIE_NAME = 'forge-board-theme';
  var match;
  var stored;
  try {
    match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`));
    stored = match ? decodeURIComponent(match[1]) : null;
    if (stored === 'dark' || stored === 'light') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (_e) {
    /* private browsing, etc. */
  }
})();
