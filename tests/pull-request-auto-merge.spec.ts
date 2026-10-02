import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `pr-auto-merge-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'PR Auto-merge Test User',
  );
}

interface MockPR {
  behind?: boolean;
  forge: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  ci: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  mergeStatus: string;
  autoMergeEnabled: boolean;
}

function makePR(overrides: Partial<MockPR> = {}): MockPR {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
    author: 'claude',
    draft: false,
    ci: 'pending',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    autoMergeEnabled: false,
    ...overrides,
  };
}

function mockDashboard(page: Page, pr?: MockPR) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: pr ? [pr] : [],
        issues: [],
      }),
    }),
  );
}

// Enable auto-merge lives behind the row's "More actions" overflow
// trigger (#527), same as Dependabot/Renovate's own rarer actions — View
// pipeline moved out of this menu entirely in #636, so it no longer
// keeps a row's "More actions" trigger around on its own.
async function openMoreActions(row: Locator) {
  await row.getByRole('button', { name: 'More actions' }).click();
}

test.describe('pull request Enable auto-merge action', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('a GitHub pull request with checks still pending shows the button — this is the case auto-merge exists for', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'blocked', ci: 'pending' }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
    ).toBeVisible();
  });

  test('a Forgejo pull request shows no button — Forgejo has no equivalent one-click action yet', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ forge: 'forgejo' }));
    await page.reload();

    // No other overflow-eligible action applies to this row either (not
    // Dependabot/Renovate-authored, and View pipeline is inline now, not
    // in this menu — #636), so "More actions" shouldn't even show up.
    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'More actions' })).toHaveCount(
      0,
    );
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
    ).toHaveCount(0);
  });

  test('a pull request already auto-merging shows no button — the Auto-merge pill already says so', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ autoMergeEnabled: true }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.locator('.merge-pill.auto-merge')).toBeVisible();
    // No other overflow-eligible action applies (not Dependabot/Renovate,
    // View pipeline is inline — #636), so there's nothing left for "More
    // actions" to hold at all.
    await expect(row.getByRole('button', { name: 'More actions' })).toHaveCount(
      0,
    );
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
    ).toHaveCount(0);
  });

  test('a genuinely conflicting pull request shows no button — arming auto-merge could never succeed', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'conflicting' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'More actions' })).toHaveCount(
      0,
    );
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
    ).toHaveCount(0);
  });

  test('a pull request that is already mergeable with green checks shows no button — there is nothing left to wait for (#662)', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', ci: 'success', behind: false }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
    ).toHaveCount(0);
  });

  test('a clean-status (502) failure points at Merge instead of showing the raw GraphQL error (#662)', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/auto-merge', (route: Route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error:
            'github: graphql: Pull request Pull request is in clean status when enabling auto merge for https://github.com/alrayyes/forge-dashboard/pull/42',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Enable auto-merge' }).click();

    const banner = page.locator('#error-banner');
    await expect(banner).toContainText('already ready to merge');
    await expect(banner).not.toContainText('graphql');
  });

  test('clicking calls the API immediately, with no confirm step', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    let requestBody: unknown;
    await page.route('**/api/pull-requests/auto-merge', (route: Route) => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [makePR({ autoMergeEnabled: true })],
          issues: [],
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Enable auto-merge' }).click();

    expect(requestBody).toEqual({
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 42,
    });
  });

  test('the Auto-merge pill appears once enabled, without a page reload', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/auto-merge', (route: Route) =>
      route.fulfill({ status: 204 }),
    );
    await page.route('**/api/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [makePR({ autoMergeEnabled: true })],
          issues: [],
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.locator('.merge-pill.auto-merge')).toHaveCount(0);
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Enable auto-merge' }).click();

    await expect(row.locator('.merge-pill.auto-merge')).toBeVisible();
  });

  test('shows an in-progress status while enabling, then a success status', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route(
      '**/api/pull-requests/auto-merge',
      async (route: Route) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return route.fulfill({ status: 204 });
      },
    );
    await page.route('**/api/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [makePR({ autoMergeEnabled: true })],
          issues: [],
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Enable auto-merge' }).click();

    const status = page.locator('#status-banner');
    await expect(status).toContainText(
      'Enabling auto-merge for alrayyes/forge-dashboard#42…',
    );
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toContainText(
      'Enabled auto-merge for alrayyes/forge-dashboard#42.',
    );
  });

  test('a transient failure shows an error and re-enables the button for another try', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/auto-merge', (route: Route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error:
            'github: graphql: Auto merge is not allowed for this repository',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    const button = row.getByRole('button', { name: 'Enable auto-merge' });
    await button.click();

    await expect(page.locator('#error-banner')).toContainText('not allowed');
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  // #621: GitHub's enablePullRequestAutoMerge mutation rejects a PR its
  // own web UI happily arms auto-merge on — a non-required check still
  // pending/failing while required ones pass ("unstable" mergeable_state).
  // No status code of its own (502, same as any other unclassified
  // GraphQL failure — see the "transient failure" case above), so this is
  // matched on the real forge message text, same technique
  // reactiveMergeLockReason's own 409 case already uses. The button stays
  // retryable exactly like that other unclassified-502 case above —
  // arming ahead of CI settling is the point of the feature, so a failed
  // attempt here must not lock it out.
  test('an unstable-status (502) failure explains what "unstable" means instead of showing the raw GraphQL error, and still re-enables the button', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/auto-merge', (route: Route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error:
            'github: graphql: Pull request Pull request is in unstable status when enabling auto merge for https://github.com/alrayyes/forge-dashboard/pull/42',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    const button = row.getByRole('button', { name: 'Enable auto-merge' });
    await button.click();

    const banner = page.locator('#error-banner');
    await expect(banner).toContainText(
      'a non-required check is still running or has failed',
    );
    await expect(banner).not.toContainText('graphql');
    await expect(banner).not.toContainText('unstable status when enabling');
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('a permission-denied failure locks the button for good instead of inviting another try', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/auto-merge', (route: Route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: graphql: Forbidden' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Enable auto-merge' }).click();

    const button = row.getByRole('button', { name: 'Enable auto-merge' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/permission/i);
  });

  test('a rate-limited (429) failure locks the button for good', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/auto-merge', (route: Route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Enable auto-merge' }).click();

    const button = row.getByRole('button', { name: 'Enable auto-merge' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/rate limit/i);
  });

  test('a locked button is reachable by keyboard and has no axe-core violations', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/auto-merge', (route: Route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Enable auto-merge' }).click();
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
    ).toHaveAttribute('aria-disabled', 'true');

    await page.keyboard.press('Tab');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
