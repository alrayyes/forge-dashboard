// Wires the header's #theme-toggle button, once, wherever it appears.
// theme.js (loaded synchronously in <head>) only applies whatever theme
// cookie is already set, before first paint -- this is the click handler
// that actually flips it, shared by every page instead of duplicated.
// Loaded at the bottom of the body, after the button markup, same
// placement as footer.js/nav.js; the SvelteKit layout injects it the
// same way those two are injected (see web/src/routes/+layout.svelte).
(() => {
  var THEME_COOKIE = 'forge-board-theme';
  var root = document.documentElement;
  var toggle = document.getElementById('theme-toggle');
  if (!toggle) return;

  function getCookie(name) {
    var match = document.cookie.match(
      new RegExp(
        `(?:^|; )${name.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`,
      ),
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value) {
    var maxAgeSeconds = 365 * 24 * 60 * 60;
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API isn't in Safari yet, and this repo targets more than just Chromium (browser-compat.md).
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
  }

  function systemPrefersDark() {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme(theme) {
    if (theme === 'dark' || theme === 'light') {
      root.setAttribute('data-theme', theme);
    } else {
      root.removeAttribute('data-theme');
    }
    var isDark = theme === 'dark' || (theme !== 'light' && systemPrefersDark());
    toggle.setAttribute('aria-pressed', String(isDark));
    toggle.setAttribute(
      'aria-label',
      isDark ? 'Switch to light theme' : 'Switch to dark theme',
    );
  }

  applyTheme(getCookie(THEME_COOKIE));

  toggle.addEventListener('click', () => {
    var currentlyDark =
      root.getAttribute('data-theme') === 'dark' ||
      (!root.getAttribute('data-theme') && systemPrefersDark());
    var next = currentlyDark ? 'light' : 'dark';
    applyTheme(next);
    setCookie(THEME_COOKIE, next);
  });
})();
