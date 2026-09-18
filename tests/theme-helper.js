// Forces a theme for the signed-in test user without going through the
// Settings page's own control — for tests whose real concern is
// something else (a color computed under dark mode, theme.js's own
// cookie-driven pre-paint behavior) and just need "dark mode is on" as a
// starting condition. Settings' own control itself is what
// settings.spec.js exercises directly.
//
// Sets both the cookie and the server value, matching exactly what
// Settings' own selectTheme() does (see $lib/theme.ts): a page that's
// migrated to SvelteKit reconciles the two on load and would otherwise
// silently revert a cookie-only change back to the server's stale value,
// while a page that hasn't migrated yet (the dashboard, until it does)
// only ever reads the cookie and would never see a server-only change at
// all. Setting both keeps this helper correct either way.
async function setTheme(page, theme) {
  await page.evaluate(async (value) => {
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API isn't in Safari yet, and this repo targets more than just Chromium (browser-compat.md).
    document.cookie = `forge-board-theme=${value}; path=/; max-age=31536000; SameSite=Lax`;
    await fetch('/api/settings/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ theme: value }),
    });
  }, theme);
}

module.exports = { setTheme };
