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

const THEME_SAVE_PENDING_COOKIE = 'forge-board-theme-pending';

// #548: selectTheme's own PUT is fire-and-forget, so a reload issued
// right after picking a theme can beat that save to the server —
// syncThemeFromServer then has to know not to trust its own GET below
// over the cookie in that case. A plain in-memory flag wouldn't survive
// the reload; a cookie does. Cleared by whichever side gets a definite
// answer first — the saving tab, once it sees an actual response rather
// than its own fetch merely rejecting (ambiguous: offline, or this very
// tab navigating away mid-request), or syncThemeFromServer's own resend
// below, once that lands. The short max-age is only the fallback for
// neither ever getting the chance (both tabs gone) — long enough to
// outlast the race, short enough that a stuck flag can't block a real
// cross-device sync for more than a minute.
const SAVE_PENDING_MAX_AGE_SECONDS = 60;

export function markThemeSavePending(): void {
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API isn't in Safari yet, and this repo targets more than just Chromium (browser-compat.md).
    document.cookie = `${THEME_SAVE_PENDING_COOKIE}=1; path=/; max-age=${SAVE_PENDING_MAX_AGE_SECONDS}; SameSite=Lax`;
  } catch {
    /* private browsing, etc. */
  }
}

export function clearThemeSavePending(): void {
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API isn't in Safari yet, and this repo targets more than just Chromium (browser-compat.md).
    document.cookie = `${THEME_SAVE_PENDING_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  } catch {
    /* private browsing, etc. */
  }
}

export function isThemeSavePending(): boolean {
  try {
    return /(?:^|; )forge-board-theme-pending=1(?:;|$)/.test(document.cookie);
  } catch {
    return false;
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
    const cookieTheme = getThemeCookie();
    if (serverTheme === cookieTheme) return;

    if (isThemeSavePending()) {
      // The tab that picked cookieTheme never got the chance to see its
      // own save's response (#548) — trust the cookie over this
      // possibly-stale GET instead of "reconciling" the just-picked
      // theme away, and nudge the save through again in case it never
      // actually reached the server. Left pending until that resend
      // actually lands: clearing it up front, before it's confirmed,
      // is exactly what let the Settings page's own concurrent load
      // (isThemeSavePending, +page.svelte) read a still-stale GET as
      // final and show the wrong control checked.
      void fetch('/api/settings/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ theme: cookieTheme }),
      })
        .then((res) => {
          if (res.ok) clearThemeSavePending();
        })
        .catch(() => {
          /* still unconfirmed — leave pending set */
        });
      return;
    }

    setThemeCookie(serverTheme);
    applyTheme(serverTheme);
  } catch {
    /* offline, etc. */
  }
}
