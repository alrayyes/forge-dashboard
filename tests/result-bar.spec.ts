import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// One result bar under the filter bar: the count, the Filtered tag, the sort
// and Clear filters (#4288). The menu pill keeps the unfiltered total, and a
// polite live region says "N of M" when a filter changes it.
// https://github.com/alrayyes/forge-dashboard/issues/4288

const NOW = new Date().toISOString();

const pr = (number: number, title: string) => ({
  forge: 'github',
  repo: 'acme/app',
  number,
  title,
  url: `https://example.com/pull/${number}`,
  author: 'claude',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: NOW,
  updatedAt: NOW,
  mergeStatus: 'mergeable',
});

const PRS = [
  pr(1, 'Alpha one'),
  pr(2, 'Alpha two'),
  pr(3, 'Beta one'),
  pr(4, 'Beta two'),
];

async function open(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: NOW,
        forges: [forgeHealth('github')],
        pullRequests: PRS,
        issues: [],
        openIssueCount: 0,
        navCounts: navCountsFor(PRS, 0),
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
}

const bar = (page: Page) => page.locator('#result-bar');
const filterTo = (page: Page, text: string) =>
  page.locator('#title-filter').fill(text);

for (const [name, width, height] of [
  ['desktop', 1280, 800],
  ['phone', 390, 844],
] as const) {
  test.describe(`result bar, ${name} (#4288)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page);
    });

    test('no filter: "4 pull requests", no Filtered tag, no Clear filters', async ({
      page,
    }) => {
      await expect(bar(page).locator('#result-count')).toHaveText(
        '4 pull requests',
      );
      await expect(bar(page).locator('#result-tag')).toBeHidden();
      await expect(bar(page).locator('#clear-filters-button')).toBeHidden();
    });

    test('a filter reads "2 of 4 pull requests" with a Filtered tag, and Clear filters resets', async ({
      page,
    }) => {
      await filterTo(page, 'Alpha');
      await expect(bar(page).locator('#result-count')).toHaveText(
        '2 of 4 pull requests',
      );
      await expect(bar(page).locator('#result-tag')).toHaveText('Filtered');
      await expect(page.locator('.row')).toHaveCount(2);
      await bar(page).locator('#clear-filters-button').click();
      await expect(bar(page).locator('#result-count')).toHaveText(
        '4 pull requests',
      );
      await expect(bar(page).locator('#result-tag')).toBeHidden();
      await expect(page.locator('.row')).toHaveCount(4);
    });

    test('the sort select sits in the bar, is 32px high (44px on a phone) and reads "Sorted by <choice>"', async ({
      page,
    }) => {
      const sort = bar(page).locator('#pr-sort-select');
      await expect(sort).toBeVisible();
      await expect(sort).toHaveAccessibleName(/sort/i);
      await expect(sort.locator('option:checked')).toHaveText(
        'Sorted by Last activity',
      );
      const box = await sort.boundingBox();
      // A phone keeps its 44px tap target (the bar's own rule for controls).
      expect(Math.round(box?.height ?? 0)).toBe(width > 760 ? 32 : 44);
      await sort.selectOption('created');
      await expect(sort.locator('option:checked')).toHaveText(
        'Sorted by Created',
      );
    });

    test('the menu pill keeps the unfiltered total and its name says the numbers', async ({
      page,
    }) => {
      const link = page.locator('a[href="/pull-requests.html"]').first();
      await expect(link).toHaveAttribute('aria-label', /4/);
      const before = await link.getAttribute('aria-label');
      await filterTo(page, 'Alpha');
      await expect(bar(page).locator('#result-count')).toHaveText(
        '2 of 4 pull requests',
      );
      await expect(link).toHaveAttribute('aria-label', before ?? '');
    });

    test('a polite live region announces "N of M" when a filter changes the count', async ({
      page,
    }) => {
      const live = page.locator('#result-live');
      await expect(live).toHaveAttribute('role', 'status');
      await expect(live).toHaveAttribute('aria-live', 'polite');
      await filterTo(page, 'Alpha');
      await expect(live).toHaveText('2 of 4 pull requests');
      await filterTo(page, '');
      await expect(live).toHaveText('4 pull requests');
    });

    test('axe finds nothing in the bar, filtered or not', async ({ page }) => {
      for (const text of ['', 'Alpha']) {
        await filterTo(page, text);
        await expect(bar(page).locator('#result-count')).toContainText(
          text ? '2 of 4' : '4 pull',
        );
        const results = await new AxeBuilder({ page })
          .include('#result-bar')
          .analyze();
        expect(results.violations).toEqual([]);
      }
    });
  });
}
