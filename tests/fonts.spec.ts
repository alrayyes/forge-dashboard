import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// The checks that the fonts come from the app, swap in and are preloaded are
// Go tests over the built files (internal/api/static_pages_test.go). What stays
// here needs a browser: which sheets block paint, and that a face really loads.

async function loadedFaces(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => `${f.family.replace(/"/g, '')} ${f.weight}`);
  });
}

// #1069: the layout's own CSS (which holds the @font-face rules) rides in the
// page's HTML, so /style.css is the only stylesheet that blocks the first
// paint. SvelteKit keeps a disabled, never-matching <link> per inlined sheet
// for client-side navigation; those don't block. Only the login page is
// checked: every page shares the one layout, so the others inline the same
// sheets, but nothing here asserts it.
test.describe('render-blocking stylesheets (#1069)', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test('the login page blocks first paint on /style.css alone', async ({
    page,
  }) => {
    await page.goto('/login.html');
    const blocking = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
        .filter((l) => !l.disabled && l.media !== '(max-width: 0)')
        .map((l) => new URL(l.href).pathname),
    );
    expect(blocking).toEqual(['/style.css']);
    expect(await loadedFaces(page)).toContain('IBM Plex Sans 400');
  });
});
