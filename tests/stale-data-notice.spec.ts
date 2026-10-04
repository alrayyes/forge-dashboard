import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #933: a forge that failed its last refresh keeps its rows (backend #922) and
// says when they are from, in plain text next to the forge.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `stale-data-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Stale Data');
}

async function open(page: Page, health: Record<string, unknown>) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', repoCount: 1, ...health }],
        pullRequests: [],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.reload();
}

const MINUTES_AGO = (n: number) =>
  new Date(Date.now() - n * 60_000).toISOString();

test.describe('stale data notice (#933)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('an unreachable forge with staleSince says how old its data is', async ({
    page,
  }) => {
    await open(page, {
      reachable: false,
      errorKind: 'unreachable',
      error: 'dial tcp: timeout',
      staleSince: MINUTES_AGO(3),
    });
    await expect(page.locator('#forge-health')).toContainText(
      'Showing data from 3m ago',
    );
  });

  test('a rate-limited forge says it too', async ({ page }) => {
    await open(page, {
      reachable: false,
      errorKind: 'rate_limited',
      error: 'rate limited',
      staleSince: MINUTES_AGO(12),
    });
    await expect(page.locator('#forge-health')).toContainText(
      'Showing data from 12m ago',
    );
  });

  test('no staleSince, no notice', async ({ page }) => {
    await open(page, { reachable: true });
    await expect(page.locator('#forge-health')).toContainText('reachable');
    await expect(page.locator('#forge-health')).not.toContainText(
      'Showing data',
    );
  });

  test('on a phone it is plain text and axe finds nothing', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await open(page, {
      reachable: false,
      errorKind: 'unreachable',
      error: 'dial tcp: timeout',
      staleSince: MINUTES_AGO(3),
    });
    await expect(page.locator('#forge-health')).toContainText(
      'Showing data from 3m ago',
    );
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
