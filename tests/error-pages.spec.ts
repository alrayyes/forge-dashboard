import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

// #1175, rules/error-pages.md: the dashboard's own 404 and 500 pages, in the
// app's look, with a way out and nothing about its internals. The build
// emits them as 404.html and 500.html and the Go server sends them with the
// real status: the 404 for an address nothing matches, the 500 for a crash.
// The server answers a request for either file by name as a plain 404, so the
// 500 page is opened the way the server sends it: its built file, served at
// another address with a 500.

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const STATIC_DIR = join(__dirname, '..', 'internal', 'api', 'static');
const BODY_500 = readFileSync(join(STATIC_DIR, '500.html'), 'utf8');
const BODY_404 = readFileSync(join(STATIC_DIR, '404.html'), 'utf8');

const PAGES = [
  {
    name: '404 page',
    title: 'Page not found',
    headline: 'Page not found',
    chip: '404',
    body: BODY_404,
    status: 404,
  },
  {
    name: '500 page',
    title: 'Something went wrong',
    headline: 'Something went wrong on our side',
    chip: '500',
    body: BODY_500,
    status: 500,
  },
];

// Served at an address that isn't the file's own, the way the server does it.
async function openError(page: Page, body: string, status: number) {
  await page.route('**/some/crashed/address', (route) =>
    route.fulfill({
      status,
      contentType: 'text/html; charset=utf-8',
      body,
    }),
  );
  const response = await page.goto('/some/crashed/address');
  expect(response?.status()).toBe(status);
}

// The served HTML, not the hydrated DOM: the browser adds its own preload
// links with the page's origin, which isn't the app leaking anything.
function expectNoInternals(html: string) {
  expect(html).not.toMatch(
    /node_modules|\.svelte|\.ts:\d|stack ?trace|at \S+ \(/i,
  );
  expect(html).not.toMatch(/localhost|127\.0\.0\.1|HTTP\/\d/);
}

test.describe('error pages (#1175)', () => {
  for (const { name: pageName, title, headline, chip, body, status } of PAGES) {
    test(`the ${pageName} says what happened, in plain words, and links home`, async ({
      page,
    }) => {
      await openError(page, body, status);

      await expect(page).toHaveTitle(new RegExp(title));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        headline,
      );
      await expect(page.locator('.error-status')).toContainText(chip);
      const home = page.getByRole('link', { name: 'Back to pull requests' });
      await expect(home).toHaveAttribute('href', '/');
      for (const [name, href] of [
        ['Issues', '/issues.html'],
        ['Releases', '/releases.html'],
        ['Insights', '/insights.html'],
        ['Settings', '/settings.html'],
      ]) {
        await expect(
          page
            .getByRole('navigation', { name: 'Where to go next' })
            .getByRole('link', { name }),
        ).toHaveAttribute('href', href);
      }
      expectNoInternals(body);
    });

    test(`the ${pageName} has no axe-core violations at desktop and 375px, and no horizontal scroll`, async ({
      page,
    }) => {
      await openError(page, body, status);
      expect(
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
      ).toEqual([]);

      await page.setViewportSize({ width: 375, height: 800 });
      expect(
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
      ).toEqual([]);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test(`the ${pageName} follows the dark theme`, async ({
      page,
      context,
      baseURL,
    }) => {
      await context.addCookies([
        { name: 'forge-board-theme', value: 'dark', url: baseURL ?? '' },
      ]);
      await openError(page, body, status);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
      ).toEqual([]);
    });
  }

  test('the 500 page offers Try again, a link back to the same address', async ({
    page,
  }) => {
    await openError(page, BODY_500, 500);
    const again = page.getByRole('link', { name: 'Try again' });
    await expect(again).toBeVisible();
    await expect(again).toHaveAttribute('href', '?');
  });

  test('the 404 page offers no Try again, since the address is the problem', async ({
    page,
  }) => {
    await openError(page, BODY_404, 404);
    await expect(page.getByRole('link', { name: 'Try again' })).toHaveCount(0);
  });

  test('neither page starts the app, so a router never swaps it for another page', async ({
    page,
  }) => {
    await openError(page, BODY_500, 500);
    // The server sends it at whatever address crashed, here one that is a
    // real page of the app.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Something went wrong on our side',
    );
    expect(BODY_500).not.toContain('<script type="module"');
    expect(BODY_404).not.toContain('<script type="module"');
  });
});
