import { expect } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// #1569: /style.css no longer blocks first paint. The rules the shell needs
// (theme tokens, base, header, nav, footer) ride in each page's HTML and the
// full file loads behind them. A delayed /style.css stands in for a slow link.

const delayStyleCss = (page: import('@playwright/test').Page, ms: number) =>
  page.route('**/style.css', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });

// .board-head-controls only exists in the full sheet, outside every
// critical block, so its display says whether the full sheet applied.
const lateRule = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'board-head-controls';
    document.body.append(probe);
    const display = getComputedStyle(probe).display;
    probe.remove();
    return display;
  });

test.describe('critical CSS (#1569)', () => {
  test('the login page has no render-blocking stylesheet request', async ({
    page,
  }) => {
    await page.goto('/login.html');
    const blocking = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
        .filter(
          (l) =>
            !l.disabled &&
            l.media !== '(max-width: 0)' &&
            !l.closest('noscript'),
        )
        .map((l) => `${new URL(l.href).pathname} media=${l.media}`),
    );
    // The full sheet is there, but its media was swapped to all only after
    // it loaded, so it never held the first paint.
    expect(blocking).toEqual(['/style.css media=all']);
    const html = await (await page.request.get('/login.html')).text();
    expect(html).toMatch(/<link[^>]*href="\/style\.css"[^>]*media="print"/);
  });

  test('the shell paints styled before the full sheet arrives, and the full sheet then applies', async ({
    page,
  }) => {
    await delayStyleCss(page, 1500);
    await page.goto('/login.html', { waitUntil: 'commit' });
    await expect(page.locator('footer')).toBeVisible();
    expect(
      await page
        .locator('body')
        .evaluate((el) => getComputedStyle(el).fontFamily),
    ).toContain('IBM Plex Sans');
    expect(await lateRule(page)).not.toBe('flex');
    await expect.poll(() => lateRule(page), { timeout: 5000 }).toBe('flex');
  });

  test('a saved light theme holds against a dark colour scheme before and after the full sheet', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await context.addCookies([
      { name: 'forge-board-theme', value: 'light', url: baseURL as string },
    ]);
    await delayStyleCss(page, 1500);
    await page.goto('/login.html', { waitUntil: 'commit' });
    await expect(page.locator('footer')).toBeVisible();
    const bg = () =>
      page
        .locator('body')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    const early = await bg();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    expect(early).toBe('rgb(238, 241, 246)');
    await expect.poll(() => lateRule(page), { timeout: 5000 }).toBe('flex');
    expect(await bg()).toBe(early);
  });

  test('an unsaved theme follows a dark colour scheme from the first paint', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await delayStyleCss(page, 1500);
    await page.goto('/login.html', { waitUntil: 'commit' });
    await expect(page.locator('footer')).toBeVisible();
    const bg = () =>
      page
        .locator('body')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    const early = await bg();
    expect(early).toBe('rgb(11, 15, 20)');
    await expect.poll(() => lateRule(page), { timeout: 5000 }).toBe('flex');
    expect(await bg()).toBe(early);
  });

  test.describe('signed in', () => {
    test.use({ storageState: SHARED_STORAGE_STATE_PATH });
    test('page content stays hidden until the full sheet arrives, so it never shows unstyled', async ({
      page,
    }) => {
      await delayStyleCss(page, 1500);
      await page.goto('/issues.html', { waitUntil: 'commit' });
      await expect(page.locator('header').first()).toBeVisible();
      await expect(page.locator('html')).toHaveClass(/css-pending/);
      await expect(
        page.getByRole('heading', { name: 'Issues', exact: true }),
      ).toBeHidden();
      await expect(page.locator('html')).not.toHaveClass(/css-pending/, {
        timeout: 5000,
      });
      await expect(
        page.getByRole('heading', { name: 'Issues', exact: true }),
      ).toBeVisible();
    });
  });
});
