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

    test('Enter on a focused Clear filters hands focus to the filter bar, not the page', async ({
      page,
    }) => {
      await filterTo(page, 'Alpha');
      const clear = bar(page).locator('#clear-filters-button');
      await clear.focus();
      await expect(clear).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(clear).toBeHidden();
      const where = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        inBar: !!document.activeElement?.closest('.filter-bar'),
      }));
      expect(where.tag).not.toBe('BODY');
      expect(where.inBar).toBe(true);
    });

    test('the sort select sits in the bar, is 32px high on every width and reads "Sorted by <choice>"', async ({
      page,
    }) => {
      const sort = bar(page).locator('#pr-sort-select');
      await expect(sort).toBeVisible();
      await expect(sort).toHaveAccessibleName(/sort/i);
      await expect(sort.locator('option:checked')).toHaveText(
        'Sorted by Last activity',
      );
      const box = await sort.boundingBox();
      expect(Math.round(box?.height ?? 0)).toBe(32);
      // A phone's 44px target is the label around it, not a taller select.
      const wrap = await bar(page).locator('.result-sort-wrap').boundingBox();
      expect(Math.round(wrap?.height ?? 0)).toBe(width > 760 ? 32 : 44);
      await sort.selectOption('created');
      await expect(sort.locator('option:checked')).toHaveText(
        'Sorted by Created',
      );
    });

    if (width <= 760) {
      test('with no filter on, Filters, the count and the sort share one 44px line', async ({
        page,
      }) => {
        const boxes = await Promise.all(
          ['#filters-button', '#result-count', '.result-sort-wrap'].map((sel) =>
            bar(page).locator(sel).boundingBox(),
          ),
        );
        expect(boxes.every(Boolean)).toBe(true);
        const mids = boxes.map((b) => (b?.y ?? -99) + (b?.height ?? 0) / 2);
        expect(Math.max(...mids) - Math.min(...mids)).toBeLessThanOrEqual(4);
        const barBox = await bar(page).boundingBox();
        expect(barBox?.height ?? 999).toBeLessThanOrEqual(46);
        const right = (boxes[2]?.x ?? 0) + (boxes[2]?.width ?? 0);
        expect(right).toBeLessThanOrEqual(390 - 16);
      });

      test('the Filters button leads the same line as the count', async ({
        page,
      }) => {
        const trigger = await bar(page)
          .locator('#filters-button')
          .boundingBox();
        const count = await bar(page).locator('#result-count').boundingBox();
        expect(trigger).not.toBeNull();
        expect(count).not.toBeNull();
        expect(
          Math.abs(
            (trigger?.y ?? 0) +
              (trigger?.height ?? 0) / 2 -
              ((count?.y ?? 0) + (count?.height ?? 0) / 2),
          ),
        ).toBeLessThan(8);
        expect(trigger?.x ?? 0).toBeLessThan(count?.x ?? 0);
      });
    }

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

    test('axe finds nothing in the bar, filtered or not, light and dark (the Filtered tag keeps 4.5:1)', async ({
      page,
    }) => {
      for (const [text, scheme] of [
        ['', 'light'],
        ['Alpha', 'light'],
        ['Alpha', 'dark'],
      ] as const) {
        await page.emulateMedia({ colorScheme: scheme });
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
