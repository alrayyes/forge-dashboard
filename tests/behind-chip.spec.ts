import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// The "N behind the base branch" chip on the Bots page (#4624). It is not the
// Out of date pill reworded: Out of date lists every behind pull request, any
// CI, and the chip counts and lists only the green ones, the rule behind the Bots
// menu pill (navCounts.bots.behind, internal/api/nav_counts.go).

const bump = (number: number, overrides: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number,
  title: `Bump package-${number} from 1.0.0 to 1.0.1`,
  url: `https://example.com/${number}`,
  author: 'dependabot[bot]',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date(Date.now() - number * 1000).toISOString(),
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'dependency',
  ...overrides,
});

const SNAPSHOT = [
  bump(1, { behind: true }),
  bump(2, { behind: true }),
  bump(3, { behind: true, ci: 'failure' }),
  bump(4),
];

function mockDashboard(page: Page, pullRequests: unknown[]) {
  return page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests,
        issues: [],
        openIssueCount: 0,
        navCounts: navCountsFor(pullRequests, 0),
      }),
    }),
  );
}

const chip = (page: Page) =>
  page
    .locator('.filter-bar .quick-pills[data-group="merge"]')
    .getByRole('button', { name: /^\d+ behind the base branch$/ });
const rows = (page: Page) => page.locator('#pr-rows > .row');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('the behind chip (#4624)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  });

  test('counts the green behind bot pull requests, filters to them, and clears', async ({
    page,
  }) => {
    await mockDashboard(page, SNAPSHOT);
    await page.goto('/bots.html');
    await expect(rows(page)).toHaveCount(4);

    await expect(chip(page)).toHaveText('2 behind the base branch');
    await expect(chip(page)).toHaveAttribute('aria-pressed', 'false');

    await chip(page).click();
    await expect(chip(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).filter({ hasText: 'package-3' })).toHaveCount(0);

    await chip(page).click();
    await expect(chip(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(rows(page)).toHaveCount(4);
  });

  test('the Out of date pill still lists every behind pull request', async ({
    page,
  }) => {
    await mockDashboard(page, SNAPSHOT);
    await page.goto('/bots.html');
    await page.getByRole('button', { name: /^Out of date/ }).click();
    await expect(rows(page)).toHaveCount(3);
  });

  test('no chip when no green bot pull request is behind', async ({ page }) => {
    await mockDashboard(page, [
      bump(1),
      bump(2, { behind: true, ci: 'failure' }),
    ]);
    await page.goto('/bots.html');
    await expect(rows(page)).toHaveCount(2);
    await expect(chip(page)).toHaveCount(0);
  });

  for (const scheme of ['light', 'dark'] as const)
    for (const width of [320, 390, 1280])
      test(`axe is clean and nothing overflows, ${scheme} at ${width}px, pressed`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await mockDashboard(page, SNAPSHOT);
        await page.goto('/bots.html');
        await expect(rows(page)).toHaveCount(4);
        // Below 760px the filter bar's pills live in the Filters sheet.
        if (width > 760) {
          await chip(page).click();
          await expect(rows(page)).toHaveCount(2);
        }
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
});
