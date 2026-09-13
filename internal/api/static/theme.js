// Applies whatever theme was chosen via the dashboard's toggle (app.js)
// on every other page too — settings/admin/login had no theme handling
// at all, so a user who explicitly picked dark mode saw it silently
// revert to the OS default the moment they left the dashboard. Loaded
// synchronously in <head>, before first paint, so there's no flash of
// the wrong theme; index.html doesn't need this (app.js already applies
// the stored choice itself, on top of driving the toggle button there).
(() => {
  var STORAGE_KEY = 'forge-board-theme';
  var stored;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (_e) {
    /* private browsing, etc. */
  }
})();
