import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import {
  actionsFooter,
  openActionsDialog,
  viaActionsDialog,
} from './actions-dialog-helper';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The tests mock /api/dashboard and write nothing per user, so they start from
// the shared session instead of registering a user each (#1379).
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

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

// Enable auto-merge is in the row's details dialog (#527), same as
// Dependabot/Renovate's own rarer actions; View pipeline is inline on the
// row (#636). Opens the dialog and returns its footer.
async function openFooter(row: Locator) {
  return actionsFooter(await openActionsDialog(row));
}

// #705: Close is always offered, so the footer never goes empty for a row
// with nothing else to offer. What these tests pin is that the footer holds
// Close and nothing more.
async function expectFooterHoldsOnlyClose(row: Locator) {
  // Close is not alone: every row also offers Hide (#841), so the footer has
  // the two Hide items and nothing else.
  const footer = await openFooter(row);
  const names = await footer
    .locator('.details-actions')
    .getByRole('button')
    .allTextContents();
  // Merge and Cancel auto-merge are on the row itself (the button, and the
  // chip's Disarm), and the footer repeats them; the menu never held them, so
  // they are not extra actions here.
  const onTheRow = new Set(['Merge', 'Cancel auto-merge']);
  const extras = names.map((n) => n.trim()).filter((n) => !onTheRow.has(n));
  expect(extras.sort()).toEqual([
    'Close pull request',
    'Hide for 7 days',
    'Hide this pull request',
  ]);
  return footer;
}

test.describe('pull request Enable auto-merge action', () => {
  test.beforeEach(async ({ page }) => {
    // The live stream isn't part of these tests. Aborted, so a shared user's
    // concurrent pages never hold a real stream open against the server.
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
    // Each test installs its mocks, then loads the page once. A goto here would
    // load it before they exist.
  });

  test('a GitHub pull request with checks still pending shows the button — this is the case auto-merge exists for', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'blocked', ci: 'pending' }),
    );
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const footer = await openFooter(row);
    await expect(
      footer.getByRole('button', { name: 'Enable auto-merge' }),
    ).toBeVisible();
  });

  test('a pull request GitHub will not let auto-merge shows no button, and the rest of the row stays (#738)', async ({
    page,
  }) => {
    // The pipeline-analytics#367 shape: a stacked PR on an unprotected
    // base, where GitHub reports viewerCanEnableAutoMerge false.
    await mockDashboard(page, makePR({ autoMergeAllowed: false }));
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByText('A pull request')).toBeVisible();
    const footer = await expectFooterHoldsOnlyClose(row);
    await expect(
      footer.getByRole('button', { name: 'Enable auto-merge' }),
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
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const footer = await openFooter(row);
    await expect(
      footer.getByRole('button', { name: 'Enable auto-merge' }),
    ).toBeVisible();
  });

  test('a Forgejo pull request offers the button too, since this app holds that intent itself', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ forge: 'forgejo' }));
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const footer = await openFooter(row);
    await expect(
      footer.getByRole('button', { name: 'Enable auto-merge' }),
    ).toBeVisible();
  });

  test('a pull request already auto-merging shows no button — the Auto-merge pill already says so', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ autoMergeEnabled: true }));
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await expect(row.locator('.attr-chip.auto-merge')).toBeVisible();
    // No other overflow-eligible action applies (not Dependabot/Renovate,
    // View pipeline is inline — #636), so there's nothing left for the
    // dialog to hold but Close.
    const footer = await expectFooterHoldsOnlyClose(row);
    await expect(
      footer.getByRole('button', { name: 'Enable auto-merge' }),
    ).toHaveCount(0);
  });

  test('a genuinely conflicting pull request shows no button — arming auto-merge could never succeed', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'conflicting' }));
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const footer = await expectFooterHoldsOnlyClose(row);
    await expect(
      footer.getByRole('button', { name: 'Enable auto-merge' }),
    ).toHaveCount(0);
  });

  test('a pull request that is already mergeable with green checks shows no button — there is nothing left to wait for (#662)', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', ci: 'success', behind: false }),
    );
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const footer = await openFooter(row);
    await expect(
      footer.getByRole('button', { name: 'Enable auto-merge' }),
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
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await viaActionsDialog(row, (footer) =>
      footer.getByRole('button', { name: 'Enable auto-merge' }).click(),
    );

    await expect
      .poll(() => requestBody)
      .toEqual({
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
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: /^#\d+ / })).toBeVisible();
    await expect(row.locator('.attr-chip.auto-merge')).toHaveCount(0);
    await viaActionsDialog(row, (footer) =>
      footer.getByRole('button', { name: 'Enable auto-merge' }).click(),
    );

    await expect(row.locator('.attr-chip.auto-merge')).toBeVisible();
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
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await viaActionsDialog(row, (footer) =>
      footer.getByRole('button', { name: 'Enable auto-merge' }).click(),
    );

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
