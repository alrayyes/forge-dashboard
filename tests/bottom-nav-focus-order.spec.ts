import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3263
//
// The phone bottom nav is position: fixed at the bottom of the screen, so
// its place in the DOM has to be where it sits in the Tab order: last, after
// the page content and footer (WCAG 2.2 SC 2.4.3 Focus Order). Before the
// fix it sat between the header and the content, so focus left Sign out,
// jumped to the bottom of the screen and came back up to Activity.

async function mock(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

// Tab until focus leaves the document (back to the browser chrome), noting
// whether each stop is inside the bottom nav.
async function walk(page: Page) {
  const stops: { nav: boolean; label: string }[] = [];
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      return {
        nav: !!el.closest('.bottom-nav'),
        label: (el.getAttribute('aria-label') ?? el.textContent ?? '')
          .trim()
          .slice(0, 30),
      };
    });
    if (!stop) break;
    stops.push(stop);
  }
  return stops;
}

test.describe('bottom nav focus order', () => {
  test('phone: bottom nav links are the last eight stops, in order', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mock(page);
    await page.goto('/issues.html');
    await expect(page.locator('.bottom-nav')).toBeVisible();

    const stops = await walk(page);
    const first = stops.findIndex((s) => s.nav);
    expect(first, 'bottom nav reached').toBeGreaterThan(0);
    // Everything from the first nav stop to the end is the nav: nothing
    // outside it follows, and it is not wedged between header and content.
    const tail = stops.slice(first);
    expect(tail.every((s) => s.nav)).toBe(true);
    expect(tail).toHaveLength(8);
    expect(stops.slice(0, first).length).toBeGreaterThan(8);

    const lefts = await page
      .locator('.bottom-nav-link')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().left));
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
  });

  test('phone: the nav is still the Mobile navigation landmark', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mock(page);
    await page.goto('/issues.html');
    await expect(
      page.getByRole('navigation', { name: 'Mobile navigation' }),
    ).toBeVisible();
  });

  test('desktop: the bottom nav is not reachable by Tab', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mock(page);
    await page.goto('/issues.html');
    await expect(page.locator('.app-nav')).toBeVisible();

    const stops = await walk(page);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.some((s) => s.nav)).toBe(false);
  });
});
