// Applies whatever theme was last chosen (via theme-toggle.js's click
// handler, on any page) before first paint, so there's no flash of the
// wrong theme. Loaded synchronously in <head>; theme-toggle.js itself
// loads later, at the bottom of the body, and does the actual toggling.
//
// Reads the same forge-board-theme cookie app.js writes — a cookie, not
// localStorage, because it rides along on every request (surviving a
// login on a fresh tab the same way a session cookie does) and because
// this file and app.js are separate scripts with no shared module state
// to keep a single source of truth in otherwise.
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
