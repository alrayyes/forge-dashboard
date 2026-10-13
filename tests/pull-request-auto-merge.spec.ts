import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
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
  autoMergeAllowed?: boolean;
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

// #705: Close is always in "More actions", so the menu no longer vanishes
// for a row with nothing else to offer. What these tests pin is that the
// menu holds Close and nothing more.
async function expectMenuHoldsOnlyClose(row: Locator) {
  // Close is not alone any more: every row also offers Hide (#841), so it
  // sits in a menu with the two Hide items and nothing else.
  await row.getByRole('button', { name: 'More actions' }).click();
  const names = await row
    .locator('.row-actions-popover')
    .getByRole('button')
    .allTextContents();
  expect(names.map((n) => n.trim())).toEqual([
    'Close pull request',
    'Hide this pull request',
    'Hide for 7 days',
  ]);
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

  test('a pull request GitHub will not let auto-merge shows no button, and the rest of the row stays (#738)', async ({
    page,
  }) => {
    // The pipeline-analytics#367 shape: a stacked PR on an unprotected
    // base, where GitHub reports viewerCanEnableAutoMerge false.
    await mockDashboard(page, makePR({ autoMergeAllowed: false }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByText('A pull request')).toBeVisible();
    await expectMenuHoldsOnlyClose(row);
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
    ).toHaveCount(0);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a pull request GitHub reports auto-merge as allowed shows the button as before (#738)', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ autoMergeAllowed: true }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
    ).toBeVisible();
  });

  test('a Forgejo pull request offers the button too, since this app holds that intent itself', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ forge: 'forgejo' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
    ).toBeVisible();
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
    // actions" to hold but Close.
    await expectMenuHoldsOnlyClose(row);
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
    await expectMenuHoldsOnlyClose(row);
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

    await expect(row.locator('.wait-chip-label')).toHaveText('Arming');
    await expect(page.locator('#feedback-live')).toHaveAttribute(
      'aria-live',
      'polite',
    );
    const toast = page.locator('#feedback-toasts .feedback-toast').first();
    await expect(toast).toContainText('alrayyes/forge-dashboard#42');
    await expect(toast).toContainText('Auto-merge enabled.');
    await expect(page.locator('#status-banner')).toHaveCount(0);
  });
});
