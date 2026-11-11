import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';
import { setTheme } from './theme-helper';

// Forced colors drops the accent fill that marks the current page in the top
// nav and the bottom tab bar, and both kept the same border, outline and text
// decoration as every other link, so only aria-current said where you were.
// The current link needs a system-colour mark the others lack, and the mark
// must take no room.
// https://github.com/alrayyes/forge-dashboard/issues/3392

async function shape(el: Locator) {
  return el.evaluate((node) => {
    const s = getComputedStyle(node);
    return [
      s.outlineStyle,
      s.outlineWidth,
      s.borderBottomStyle,
      s.borderBottomWidth,
      s.textDecorationLine,
    ].join('|');
  });
}

async function box(el: Locator) {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10);
  });
}

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
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
  await page.goto('/pull-requests.html');
}

const NAVS = [
  { name: 'top nav', width: 1280, links: 'nav.app-nav a' },
  { name: 'bottom nav', width: 390, links: 'nav.bottom-nav a' },
];

for (const n of NAVS) {
  test(`${n.name}: the current page differs from the others under forced colors`, async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, n.width);
    const links = page.locator(n.links);
    const current = links.and(page.locator('[aria-current="page"]'));
    const other = links.and(page.locator(':not([aria-current])')).first();
    await expect(current).toHaveCount(1);
    await expect(other).toBeVisible();
    expect(await shape(current)).not.toBe(await shape(other));

    // Focused, the current link still differs from a focused other link.
    await page.keyboard.press('Shift');
    await current.focus();
    const focusedCurrent = await shape(current);
    await other.focus();
    expect(await shape(other)).not.toBe(focusedCurrent);

    // The mark takes no room.
    const withMark = await box(current);
    const otherBox = await box(other);
    await page.emulateMedia({ forcedColors: 'none' });
    expect(await box(current)).toEqual(withMark);
    expect(await box(other)).toEqual(otherBox);
  });

  for (const theme of ['light', 'dark']) {
    test(`${n.name}: axe finds nothing in ${theme}`, async ({ page }) => {
      await page.goto('/');
      await setTheme(page, theme);
      await open(page, n.width);
      const results = await new AxeBuilder({ page }).include('nav').analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
