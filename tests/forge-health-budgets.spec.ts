import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { rateLimit } from './rate-limit-mock';
import { test } from './server-fixture';

// #3681: the overview shows a budget only once less than 20% of it is left;
// the full budget lives on the Insights page.
// #1433: GitHub has two independent budgets. The text under the forge pill when shown
// shows each one, labelled, so it never describes a different budget from the
// banner, and a remaining count above its limit is never shown against that
// limit. The labels and the hidden counts are `play` functions on the
// ForgeHealth stories; what stays here needs the page's banner or its live region.
// https://github.com/alrayyes/forge-dashboard/issues/1433

const inMinutes = (m: number) =>
  new Date(Date.now() + m * 60_000).toISOString();

async function open(page: Page, forge: Record<string, unknown>) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1, ...forge }],
        pullRequests: [],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
}

const budgets = (page: Page) =>
  page.locator('#forge-health .forge-health-budget');

test.describe('the budget text on the overview (#1433)', () => {
  test('a spent GraphQL budget shows next to a healthy REST one, each labelled', async ({
    page,
  }) => {
    await open(page, {
      rateLimitGraphQL: rateLimit(5000, 0, inMinutes(12)),
      rateLimitREST: rateLimit(5000, 4800, inMinutes(40)),
    });

    await expect(budgets(page)).toHaveCount(1);
    await expect(budgets(page)).toContainText(
      /^GH GraphQL: 0\/5,000 reqs, resets .+/,
    );
    await expect(page.locator('#forge-health')).not.toContainText('GH REST');
    // The banner and the pill now describe the same budget.
    await expect(page.locator('#rate-limit-banner')).toContainText(
      /GraphQL budget is spent/,
    );
  });

  test('a remaining count above its limit is never shown on the overview', async ({
    page,
  }) => {
    await open(page, {
      rateLimitREST: {
        limit: 1000,
        remaining: 9992,
        resetsAt: inMinutes(40),
      },
    });

    await expect(page.locator('#forge-health-live')).toContainText(
      'GitHub reachable',
    );
    await expect(budgets(page)).toHaveCount(0);
  });

  test('each text stays out of the live region, and the page has no axe violations', async ({
    page,
  }) => {
    await open(page, {
      rateLimitGraphQL: rateLimit(5000, 0, inMinutes(12)),
      rateLimitREST: rateLimit(5000, 4800, inMinutes(40)),
    });
    await expect(budgets(page)).toHaveCount(1);

    for (const text of await budgets(page).all()) {
      await expect(text).toHaveAttribute('aria-live', 'off');
    }
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a budget with plenty left shows no text on the overview (#3681)', async ({
    page,
  }) => {
    await open(page, {
      rateLimitGraphQL: rateLimit(5000, 4900, inMinutes(12)),
      rateLimitREST: rateLimit(5000, 1000, inMinutes(40)),
    });
    await expect(page.locator('#rate-limit-banner')).toHaveCount(0);
    await expect(budgets(page)).toHaveCount(0);
    await expect(page.locator('#forge-health .forge-health')).toHaveCount(0);
    await expect(page.locator('#forge-names')).toHaveCount(0);
    await expect(page.locator('.dashboard-toolbar-forges')).toHaveCount(0);
    await expect(page.getByText('Connected forges')).toHaveCount(0);
  });

  for (const width of [360, 390, 1280]) {
    test(`a quiet header has no axe violations at ${width}px (#3681)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, {
        rateLimitREST: rateLimit(5000, 4900, inMinutes(40)),
      });
      await expect(budgets(page)).toHaveCount(0);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
