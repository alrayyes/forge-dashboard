import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import {
  actionsFooter,
  closeActionsDialog,
  openActionsDialog,
} from './actions-dialog-helper';
import { test } from './server-fixture';

// #705: Merge is always on an open pull request's row. Clickable when the
// forge says it can go, locked with a visible reason when it can't, and
// Close sits in the row's dialog in every one of these states.

interface MockPR {
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
  [key: string]: unknown;
}

function makePR(overrides?: Partial<MockPR>): MockPR {
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
    ...overrides,
  };
}

function mockDashboard(page: Page, pr: MockPR) {
  return page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pr],
        issues: [],
      }),
    }),
  );
}

const rowOf = (page: Page) => page.locator('#pr-rows .row').first();

test.describe('Merge states on a pull request row', () => {
  test.beforeEach(async ({ page }) => {
    // The live stream isn't part of these tests. Aborted, so no real stream
    // stays open against the server.
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
    // Each test installs its dashboard mock, then loads the page once.
  });

  // #1638: the wait chip already says what happens next, so the status area
  // keeps its message and drops the "Merge unlocks automatically" line.
  test('waiting on CI with auto-merge on drops the next-step line', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ ci: 'pending', autoMergeEnabled: true, autoMerge: 'waiting' }),
    );
    await page.goto('/pull-requests.html');

    const row = rowOf(page);
    await expect(row.getByText('Waiting for CI to finish')).toBeVisible();
    await expect(row.getByText('Merge unlocks automatically')).toHaveCount(0);
  });

  // One journey for a blocked Merge. Which states block it, and the words for
  // each, are the server's and are pinned in Go (TestAllowedActions and
  // TestAllowedActions_BlockedMergeReasonPerState): the page prints the
  // reason it is given. What only a browser proves is below.
  test('a blocked Merge is locked with the visible reason, described to assistive tech, focusable and inert', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ ci: 'pending' }));
    let mergeCalled = false;
    await page.route('**/api/pull-requests/merge', (route) => {
      mergeCalled = true;
      return route.fulfill({ status: 204 });
    });
    await page.goto('/pull-requests.html');

    const row = rowOf(page);
    const merge = row.getByRole('button', { name: 'Merge', exact: true });
    await expect(merge).toHaveAttribute('aria-disabled', 'true');
    await expect(row.getByText('Waiting for CI to finish')).toBeVisible();
    await expect(row.getByText('Merge unlocks automatically')).toBeVisible();
    await expect(merge).toHaveAccessibleDescription(/Waiting for CI to finish/);
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);

    await merge.focus();
    await expect(merge).toBeFocused();

    // force: Playwright otherwise waits forever for an aria-disabled button
    // to become enabled, and the click landing on it is the whole point.
    await merge.click({ force: true });
    await expect(
      row.getByRole('button', { name: 'Confirm merge?' }),
    ).toHaveCount(0);
    expect(mergeCalled).toBe(false);

    // Close stays off the row while Merge is locked; it is in the dialog.
    await expect(
      row.getByRole('button', { name: 'Close pull request', exact: true }),
    ).toHaveCount(0);
    const dialog = await openActionsDialog(row);
    await expect(
      actionsFooter(dialog).getByRole('button', {
        name: 'Close pull request',
        exact: true,
      }),
    ).toBeVisible();
  });

  test('ready: Merge is clickable with no reason shown, and Close is in the dialog beside the Hide items', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.goto('/pull-requests.html');

    const row = rowOf(page);
    const merge = row.getByRole('button', { name: 'Merge', exact: true });
    await expect(merge).toBeEnabled();
    await expect(merge).not.toHaveAttribute('aria-disabled', 'true');
    await expect(row.locator('.row-action-note')).toHaveCount(0);

    // Close shares the dialog footer with the Hide items (#841).
    const dialog = await openActionsDialog(row);
    await expect(
      actionsFooter(dialog).getByRole('button', {
        name: 'Close pull request',
        exact: true,
      }),
    ).toBeVisible();
    await closeActionsDialog(dialog);

    await merge.click();
    await expect(
      row.getByRole('button', { name: 'Confirm merge?' }),
    ).toBeVisible();
  });

  test('a Renovate pull request waiting on CI keeps its bot layout, with Merge locked and Close in the dialog', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({
        author: 'renovate[bot]',
        title: 'chore(deps): update dependency foo to v2',
        ci: 'pending',
      }),
    );
    // Bot pull requests are on the Bots page, not the main list (#1192).
    await page.goto('/bots.html');

    const row = rowOf(page);
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');
    const dialog = await openActionsDialog(row);
    await expect(
      actionsFooter(dialog).getByRole('button', {
        name: 'Close pull request',
        exact: true,
      }),
    ).toBeVisible();
  });

  for (const [name, overrides] of [
    ['blocked', { ci: 'pending' }],
    ['ready', {}],
  ] as const) {
    test(`${name}: no axe-core violations`, async ({ page }) => {
      await mockDashboard(page, makePR(overrides));
      await page.goto('/pull-requests.html');
      await expect(
        rowOf(page).getByRole('button', { name: 'Merge', exact: true }),
      ).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('axe-core finds nothing with the dialog open on a waiting row', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ ci: 'pending' }));
    await page.goto('/pull-requests.html');
    await openActionsDialog(rowOf(page));

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
