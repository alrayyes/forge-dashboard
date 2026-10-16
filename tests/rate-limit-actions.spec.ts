import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';
import { severityOf } from './severity-stand-in';

// A rate limit is a "wait until" condition, not a transient fault: the
// forge says when it resets, so the blocked actions are greyed out with
// that time, carry no Retry button, and come back by themselves.
// https://github.com/alrayyes/forge-dashboard/issues/732

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `rate-limit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Rate Limit User');
}

interface RateLimit {
  limit: number;
  remaining: number;
  resetsAt: string;
}

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: true,
    ...overrides,
  };
}

async function mockDashboard(
  page: Page,
  rateLimitREST?: RateLimit,
  prs: Record<string, unknown>[] = [makePR()],
) {
  const body = () =>
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: [
        {
          forge: 'github',
          reachable: true,
          repoCount: 1,
          rateLimitREST: rateLimitREST && {
            ...rateLimitREST,
            severity: severityOf(rateLimitREST.limit, rateLimitREST.remaining),
          },
        },
      ],
      pullRequests: prs,
      issues: [],
    });
  await page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: body(),
    }),
  );
}

const exhausted = (inMs = 12 * 60 * 1000): RateLimit => ({
  limit: 5000,
  remaining: 0,
  resetsAt: new Date(Date.now() + inMs).toISOString(),
});

const firstRow = (page: Page) => page.locator('#pr-rows .row').first();

async function expectLockedWithoutRetry(row: Locator, label: string) {
  const button = row.getByRole('button', { name: label, exact: true });
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  return button;
}

test.describe('rate-limited actions (#732)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('grouped by repo, the reset time is stated once in the banner, not under each group', async ({
    page,
  }) => {
    await mockDashboard(page, exhausted(), [
      makePR({ number: 1 }),
      makePR({ number: 2 }),
    ]);
    await page.reload();
    await page.locator('#shared-group-select').selectOption('repo');

    await expect(page.locator('#pr-rows .group-rate-limit')).toHaveCount(0);
    await expect(
      page.locator('#rate-limit-banner .rate-limit-banner-row'),
    ).toHaveCount(1);
  });

  test('a 429 on merge locks the actions with the reset time and no Retry', async ({
    page,
  }) => {
    await mockDashboard(page, { ...exhausted(), remaining: 3 });
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: rate limit exceeded',
          code: 'rate_limited',
          message: "The forge's API rate limit is reached.",
        }),
      }),
    );
    await page.reload();

    const row = firstRow(page);
    await row.getByRole('button', { name: 'Merge', exact: true }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const button = await expectLockedWithoutRetry(row, 'Merge');
    await expect(button).toHaveAccessibleDescription(
      /GitHub API rate limit reached\. Actions resume at/,
    );
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  });

  test('a 502 on merge still offers Retry, and it works', async ({ page }) => {
    await mockDashboard(page);
    let calls = 0;
    await page.route('**/api/pull-requests/merge', (route) => {
      calls += 1;
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PUT .../merge: Bad Gateway',
          code: 'unknown',
          message: 'Bad Gateway',
        }),
      });
    });
    await page.reload();

    const row = firstRow(page);
    await row.getByRole('button', { name: 'Merge', exact: true }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const retry = row.getByRole('button', { name: /^Retry/ });
    await expect(retry).toBeVisible();
    await retry.click();
    // A merge is never re-sent without its confirm step.
    await row.getByRole('button', { name: 'Confirm merge?' }).click();
    await expect.poll(() => calls).toBe(2);
  });

  test('the ticking countdown is not announced every second', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    await mockDashboard(page, exhausted(10 * 60 * 1000));
    await page.reload();

    const banner = page.locator('#rate-limit-banner');
    await expect(banner).toBeVisible();
    await banner.evaluate((node) => node.setAttribute('data-probe', '1'));

    await page.clock.fastForward(3000);

    // The same node is still on the page, so a screen reader hasn't been
    // handed a fresh alert, and the changing number is hidden from it.
    await expect(banner).toHaveAttribute('data-probe', '1');
    await expect(banner.locator('.rate-limit-banner-timer')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    await expect(page.locator('#feedback-live')).toHaveText('');
  });
});
