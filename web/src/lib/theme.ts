// Shared by every page's root layout (theme sync on load) and the
// Settings page (the only place a user can actually change it, #352).
//
// The cookie stays the fast, synchronous, pre-paint local cache —
// app.html's own <script src="/theme.js"> reads it before first paint,
// same contract every page already relied on before the header toggle
// existed. This module owns everything downstream of that: writing the
// cookie, applying data-theme after the fact, and reconciling the cookie
// against the server's saved value on load so a theme picked on one
// device shows up on another. A user with no cookie yet (a genuinely new
// browser) still gets one flash while syncThemeFromServer's fetch
// resolves — an accepted tradeoff, not a bug, since there's nothing to
// read synchronously before that request completes.

export const THEME_COOKIE = 'forge-board-theme';

export type ThemePreference = '' | 'light' | 'dark';

function normalize(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : '';
}

export function getThemeCookie(): ThemePreference {
  try {
    const match = document.cookie.match(/(?:^|; )forge-board-theme=([^;]*)/);
    return normalize(match ? decodeURIComponent(match[1]) : null);
  } catch {
    return '';
  }
}

export function setThemeCookie(theme: ThemePreference): void {
  try {
    const maxAgeSeconds = 365 * 24 * 60 * 60;
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API isn't in Safari yet, and this repo targets more than just Chromium (browser-compat.md).
    document.cookie = `${THEME_COOKIE}=${encodeURIComponent(theme)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
  } catch {
    /* private browsing, etc. */
  }
}

export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') {
    root.setAttribute('data-theme', theme);
  } else {
    root.removeAttribute('data-theme');
  }
}

// Called from every page's root layout on mount. A 401 (not signed in —
// the login page itself) or any network failure just leaves whatever
// theme.js already applied from the cookie alone.
export async function syncThemeFromServer(): Promise<void> {
  try {
    const res = await fetch('/api/settings/theme', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const data: { theme?: string } = await res.json();
    const serverTheme = normalize(data.theme);
    if (serverTheme !== getThemeCookie()) {
      setThemeCookie(serverTheme);
      applyTheme(serverTheme);
    }
  } catch {
    /* offline, etc. */
  }
}
