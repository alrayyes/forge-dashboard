import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

// #797: the fonts are served by the app itself. No page waits on, or sends
// a visitor's address to, a third-party host just to render text.

// What the config's resolver rule used to hide: a font host that never
// answers. Routing the request to nowhere hangs it the same way dropped
// packets do, so a render-blocking stylesheet would hold the page.
async function hangFontHosts(page: Page) {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, () => {
    /* never fulfilled */
  });
}

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
  test('the login page loads while the Google font hosts hang', async ({
    page,
  }) => {
    await hangFontHosts(page);
    const started = Date.now();
    await page.goto('/login.html', { timeout: 8000 });
    await expect(page.locator('body')).toBeVisible();
    expect(Date.now() - started).toBeLessThan(4000);
  });

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
  test('the dashboard requests no other host either', async ({
    page,
    request,
    baseURL,
  }: {
    page: Page;
    request: APIRequestContext;
    baseURL?: string;
  }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      `fonts-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'Fonts Test User',
    );
    const hosts = recordHosts(page);
    await page.goto('/');
    await loadedFaces(page);

    expect([...hosts]).toEqual([new URL(baseURL ?? '').host]);
  });
});
