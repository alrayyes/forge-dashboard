import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// #797: the fonts are served by the app itself. No page waits on, or sends
// a visitor's address to, a third-party host just to render text.

function recordHosts(page: Page) {
  const hosts = new Set<string>();
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.protocol.startsWith('http')) hosts.add(url.host);
  });
  return hosts;
}

async function loadedFaces(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => `${f.family.replace(/"/g, '')} ${f.weight}`);
  });
}

test.describe('self-hosted fonts (#797)', () => {
  test('the login page requests no other host, for CSS or fonts', async ({
    page,
    baseURL,
  }) => {
    const hosts = recordHosts(page);
    await page.goto('/login.html');
    await loadedFaces(page);

    expect([...hosts]).toEqual([new URL(baseURL ?? '').host]);
  });

  test('IBM Plex Sans and Mono load from the app, with font-display swap', async ({
    page,
  }) => {
    await page.goto('/login.html');
    const faces = await loadedFaces(page);
    expect(faces.some((f) => f.startsWith('IBM Plex Sans'))).toBe(true);
    expect(faces.some((f) => f.startsWith('IBM Plex Mono'))).toBe(true);

    const display = await page.evaluate(() =>
      [...document.fonts].map((f) => f.display),
    );
    expect(display.length).toBeGreaterThan(0);
    for (const d of display) expect(d).toBe('swap');
  });
});

test.describe('self-hosted fonts on the dashboard (#797)', () => {
  // Writes nothing per user, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('the dashboard requests no other host either', async ({
    page,
    baseURL,
  }) => {
    const hosts = recordHosts(page);
    await page.goto('/pull-requests.html');
    await loadedFaces(page);

    expect([...hosts]).toEqual([new URL(baseURL ?? '').host]);
  });
});

// #1069: the layout's own CSS (which holds the @font-face rules) rides in the
// page's HTML. #1569 did the same for the critical part of /style.css and
// loads the rest with media="print" until it arrives, so no stylesheet in the
// served HTML blocks the first paint. SvelteKit keeps a disabled, never-matching
// <link> per inlined sheet for client-side navigation; those don't block.
// Only the login page is checked: every page shares the one layout.
test.describe('render-blocking stylesheets (#1069)', () => {
  test('the login page ships no stylesheet link that blocks first paint', async ({
    page,
  }) => {
    const html = await (await page.request.get('/login.html')).text();
    const links = [
      ...html
        .replace(/<noscript>[\s\S]*?<\/noscript>/g, '')
        .matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g),
    ].map((m) => m[0]);
    const blocking = links.filter(
      (l) =>
        !/\bdisabled\b/.test(l) && !/media="(print|\(max-width: 0\))"/.test(l),
    );
    expect(blocking).toEqual([]);
    await page.goto('/login.html');
    expect(await loadedFaces(page)).toContain('IBM Plex Sans 400');
  });
});
