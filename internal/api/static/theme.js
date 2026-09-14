// Applies whatever theme was chosen via the dashboard's toggle (app.js)
// on every other page too — settings/admin/login had no theme handling
// at all, so a user who explicitly picked dark mode saw it silently
// revert to the OS default the moment they left the dashboard. Loaded
// synchronously in <head>, before first paint, so there's no flash of
// the wrong theme; index.html doesn't need this (app.js already applies
// the stored choice itself, on top of driving the toggle button there).
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
