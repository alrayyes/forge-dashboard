import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';
import { rateLimit } from './severity-stand-in';

// #1433: GitHub has two independent budgets. The text under the forge pill
// shows each one, labelled, so it never describes a different budget from the
// banner, and a remaining count above its limit is never shown against that
// limit.
// https://github.com/alrayyes/forge-dashboard/issues/1433

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `budgets-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Budgets');
}

const inMinutes = (m: number) =>
  new Date(Date.now() + m * 60_000).toISOString();

async function open(page: Page, forge: Record<string, unknown>) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
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

test.describe('the budget text under the forge pill (#1433)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('a spent GraphQL budget shows next to a healthy REST one, each labelled', async ({
    page,
  }) => {
    await open(page, {
      rateLimitGraphQL: rateLimit(5000, 0, inMinutes(12)),
      rateLimitREST: rateLimit(5000, 4800, inMinutes(40)),
    });

    await expect(budgets(page)).toHaveCount(2);
    await expect(budgets(page).nth(0)).toContainText(
      /^GH GraphQL: 0\/5,000 reqs, resets .+/,
    );
    await expect(budgets(page).nth(1)).toContainText(
      /^GH REST: 4,800\/5,000 reqs, resets .+/,
    );
    // The banner and the pill now describe the same budget.
    await expect(page.locator('#rate-limit-banner')).toContainText(
      /GraphQL budget is spent/,
    );
  });

  test('a forge with one budget still says which one it is', async ({
    page,
  }) => {
    await open(page, { rateLimitREST: rateLimit(5000, 4800, inMinutes(40)) });

    await expect(budgets(page)).toHaveCount(1);
    await expect(budgets(page)).toContainText(/^GH REST: 4,800\/5,000 reqs/);
    await expect(page.locator('#forge-health')).not.toContainText(/GH: /);
  });

  test('a Forgejo forge labels its budget with its own short name', async ({
    page,
  }) => {
    await page.route('**/api/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            {
              forge: 'forgejo',
              reachable: true,
              repoCount: 1,
              rateLimitREST: rateLimit(1000, 900, inMinutes(40)),
            },
          ],
          pullRequests: [],
          issues: [],
          repos: [],
          hiddenDrafts: 0,
        }),
      }),
    );
    await page.goto('/pull-requests.html');

    await expect(budgets(page)).toHaveCount(1);
    await expect(budgets(page)).toContainText(/^FJ REST: 900\/1,000 reqs/);
  });

  test('a remaining count above its limit is never shown against that limit', async ({
    page,
  }) => {
    await open(page, {
      rateLimitREST: {
        limit: 1000,
        remaining: 9992,
        resetsAt: inMinutes(40),
        severity: 'ok',
      },
    });

    await expect(budgets(page)).toHaveCount(1);
    await expect(budgets(page)).toContainText(
      /^GH REST: 9,992 reqs left, resets .+/,
    );
    await expect(budgets(page)).not.toContainText('/1,000');
  });

  test('each text stays out of the live region, and the page has no axe violations', async ({
    page,
  }) => {
    await open(page, {
      rateLimitGraphQL: rateLimit(5000, 0, inMinutes(12)),
      rateLimitREST: rateLimit(5000, 4800, inMinutes(40)),
    });
    await expect(budgets(page)).toHaveCount(2);

    for (const text of await budgets(page).all()) {
      await expect(text).toHaveAttribute('aria-live', 'off');
    }
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
