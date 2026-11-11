import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { mainBranchPageFor } from './nav-counts-helper';
import { test } from './server-fixture';

// A nav pill leaves the neutral total out when it would only repeat its one
// count: "2 running" reads as 2 running, not "2 2". The total stays when two
// categories are present, or when the one category is below the total (the
// rest are in no category), so the number still agrees with the page. The
// tab bar is the stacked variant of the pill.
// https://github.com/alrayyes/forge-dashboard/issues/3489

type Counts = {
  total: number;
  running: number;
  failed: number;
  passed: number;
  noChecks?: number;
};

const PRS = '/pull-requests.html';
const NONE: Counts = { total: 0, running: 0, failed: 0, passed: 0 };

async function open(page: Page, pullRequests: Counts) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [],
        navCounts: {
          pullRequests,
          issues: { total: 4 },
          releases: NONE,
          bots: NONE,
        },
        mainBranchPage: mainBranchPageFor(0, 0),
      }),
    }),
  );
  await page.goto('/settings.html');
}

const header = (page: Page) => page.locator(`.app-nav a[href="${PRS}"]`);
const tab = (page: Page) => page.locator(`.bottom-nav a[href="${PRS}"]`);

const cases = [
  {
    name: 'one category equal to the total',
    counts: { total: 2, running: 2, failed: 0, passed: 0 },
    total: false,
    parts: 1,
    headerName: '2, Pull requests, 2 running',
    tabName: '2 PRs, 2 running',
  },
  {
    name: 'two categories',
    counts: { total: 4, running: 2, failed: 2, passed: 0 },
    total: true,
    parts: 2,
    headerName: '4 2 2, Pull requests, 4 total, 2 failing, 2 running',
    tabName: '4 2 2 PRs, 2 failing, 2 running',
  },
  {
    name: 'one category below the total',
    counts: { total: 5, running: 0, failed: 0, passed: 3 },
    total: true,
    parts: 1,
    headerName: '5 3, Pull requests, 5 total, 3 passing',
    tabName: '5 3 PRs, 3 passing',
  },
];

for (const c of cases) {
  test.describe(c.name, () => {
    test('header icon', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await open(page, c.counts);
      await expect(header(page).locator('.nav-count')).toHaveCount(c.parts);
      await expect(header(page).locator('.nav-total')).toHaveCount(
        c.total ? 1 : 0,
      );
      await expect(header(page)).toHaveAccessibleName(c.headerName);
    });

    test('tab bar, stacked', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 740 });
      await open(page, c.counts);
      await expect(tab(page).locator('.nav-count')).toHaveCount(c.parts);
      await expect(tab(page).locator('.nav-total')).toHaveCount(
        c.total ? 1 : 0,
      );
      await expect(tab(page)).toHaveAccessibleName(c.tabName);
      const box = await tab(page).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}

test('the zero-count pill is unchanged: no pill at all', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, NONE);
  await expect(header(page)).toHaveCount(0);
});

test(`no axe violations with a total-less pill in both themes`, async ({
  page,
}) => {
  for (const scheme of ['light', 'dark'] as const) {
    await test.step(`${scheme}`, async () => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, cases[0].counts);
      for (const size of [
        { width: 1280, height: 800 },
        { width: 320, height: 740 },
      ]) {
        await page.setViewportSize(size);
        const pill = page.locator(`a[href="${PRS}"] .nav-pills:visible`);
        await expect(pill).toHaveCount(1);
        await expect(pill.locator('.nav-total')).toHaveCount(0);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      }
    });
  }
});
