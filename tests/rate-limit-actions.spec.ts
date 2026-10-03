import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';
import { rateLimit, severityOf } from './severity-stand-in';

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

const RESUME =
  /GitHub API rate limit reached\. Actions resume at .+ \(in \d+ min\)\./;

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

  test('an exhausted forge greys out Merge, Update branch and Close with no Retry, and says when actions resume', async ({
    page,
  }) => {
    await mockDashboard(page, exhausted());
    await page.reload();

    const row = firstRow(page);
    // Close sits in "More actions" since #705, still locked like the rest.
    await row.getByRole('button', { name: 'More actions' }).click();
    for (const label of ['Merge', 'Update branch', 'Close']) {
      const button = await expectLockedWithoutRetry(row, label);
      // The reason is the accessible description, not a hover-only tooltip.
      await expect(button).toHaveAccessibleDescription(RESUME);
    }
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  });

  test('a forge with budget left keeps its actions clickable', async ({
    page,
  }) => {
    await mockDashboard(page, { ...exhausted(), remaining: 4000 });
    await page.reload();

    const merge = firstRow(page).getByRole('button', {
      name: 'Merge',
      exact: true,
    });
    await expect(merge).toBeVisible();
    await expect(merge).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('grouped by repo, the reset time is stated once under the group heading', async ({
    page,
  }) => {
    await mockDashboard(page, exhausted(), [
      makePR({ number: 1 }),
      makePR({ number: 2 }),
    ]);
    await page.reload();
    await page.locator('#shared-group-select').selectOption('repo');

    const notes = page.locator('#pr-rows .group-rate-limit');
    await expect(notes).toHaveCount(1);
    await expect(notes).toHaveText(RESUME);
  });

  test('read-only actions stay enabled while rate limited', async ({
    page,
  }) => {
    await mockDashboard(page, exhausted());
    await page.reload();

    const pipeline = firstRow(page).getByRole('button', {
      name: 'View pipeline',
    });
    await expect(pipeline).toBeVisible();
    await expect(pipeline).not.toHaveAttribute('aria-disabled', 'true');
    await expect(pipeline).toBeEnabled();
  });

  test('the header shows the remaining budget and reset time as text', async ({
    page,
  }) => {
    await mockDashboard(page, exhausted());
    await page.reload();

    await expect(page.locator('#forge-health')).toContainText(
      /GH: 0\/5,000 reqs, resets .+/,
    );
  });

  test('actions re-enable at the reset time without a click, and a polite toast says so', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    await mockDashboard(page, exhausted(60 * 1000));
    await page.reload();

    const merge = firstRow(page).getByRole('button', {
      name: 'Merge',
      exact: true,
    });
    await expect(merge).toHaveAttribute('aria-disabled', 'true');

    await page.clock.fastForward(61 * 1000);

    await expect(merge).not.toHaveAttribute('aria-disabled', 'true');
    await expect(
      page.locator('#feedback-toasts .feedback-toast'),
    ).toContainText('Rate limit reset, actions available again');
    await expect(page.locator('#feedback-live')).toHaveText(
      'Rate limit reset, actions available again',
    );
    await expect(firstRow(page).locator('.group-rate-limit')).toHaveCount(0);
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

  test('a 403 on merge locks the actions with no Retry and points to Settings', async ({
    page,
  }) => {
    await mockDashboard(page);
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PUT .../merge: Forbidden',
          code: 'permission',
          message: 'Missing permission — check your token in Settings.',
        }),
      }),
    );
    await page.reload();

    const row = firstRow(page);
    await row.getByRole('button', { name: 'Merge', exact: true }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const button = await expectLockedWithoutRetry(row, 'Merge');
    await expect(button).toHaveAccessibleDescription(/token in Settings/);
    await expect(
      row.locator('.row-action-locked').getByText('Retry'),
    ).toHaveCount(0);
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

  test('auto-merge, a GraphQL call, locks on the GraphQL budget and leaves REST actions alone', async ({
    page,
  }) => {
    const resetsAt = new Date(Date.now() + 12 * 60 * 1000).toISOString();
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            {
              forge: 'github',
              reachable: true,
              repoCount: 1,
              rateLimitGraphQL: rateLimit(5000, 0, resetsAt),
              rateLimitREST: rateLimit(5000, 4000, resetsAt),
            },
          ],
          pullRequests: [makePR({ mergeStatus: 'blocked', ci: 'pending' })],
          issues: [],
        }),
      }),
    );
    await page.reload();

    const row = firstRow(page);
    await row.getByRole('button', { name: 'More actions' }).click();
    const autoMerge = row.getByRole('button', { name: 'Enable auto-merge' });
    await expect(autoMerge).toHaveAttribute('aria-disabled', 'true');
    await expect(autoMerge).toHaveAccessibleDescription(RESUME);
    await expect(
      row.getByRole('button', { name: 'Close', exact: true }),
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('has no axe-core violations while rate limited', async ({ page }) => {
    await mockDashboard(page, exhausted());
    await page.reload();
    await page.locator('#shared-group-select').selectOption('repo');
    await expect(page.locator('.group-rate-limit')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
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
