import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #4532: a wait that clears on its own is one line and no locked button. An
// Update branch that was asked for is the Updating branch chip alone; the
// "Behind the base branch" message and the greyed "Queued…" button leave the
// row. A block the person can act on keeps its locked button and reason.

const BEHIND = {
  code: 'behind',
  message: 'Behind the base branch',
  next: 'Bring it up to date to unlock Merge',
};
const CI_BLOCK = {
  code: 'checks_pending',
  message: 'Waiting for CI to finish',
  next: 'Merge unlocks automatically',
};

function pr(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number: 7,
    title: 'Behind',
    url: 'https://example.com/pull/7',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    status: { ...BEHIND, action: 'update_branch' },
    allowedActions: [
      { action: 'merge', blocked: BEHIND },
      { action: 'update_branch' },
      { action: 'close' },
    ],
    ...overrides,
  };
}

async function open(page: Page, pullRequest: unknown) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [pullRequest],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  return page.locator('#pr-rows > .row').first();
}

async function axeClean(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

for (const width of [1280, 390]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test('a requested update is the Updating branch chip alone', async ({
      page,
    }) => {
      await page.route('**/api/v1/pull-requests/update-branch', (route) =>
        route.fulfill({ status: 202 }),
      );
      const row = await open(page, pr());
      await row.getByRole('button', { name: 'Update branch' }).click();

      await expect(row.locator('.wait-chip-label')).toHaveText(
        'Updating branch',
      );
      await expect(row.getByRole('button', { name: 'Queued…' })).toHaveCount(0);
      await expect(row.locator('[aria-disabled="true"]')).toHaveCount(0);
      await expect(row).not.toContainText('Behind the base branch');
      await expect(row).not.toContainText('Bring it up to date');
      await expect(row.locator('.wait-chip')).toBeVisible();
      await axeClean(page);
    });

    test('an armed pull request waiting on CI has one line and no locked Merge', async ({
      page,
    }) => {
      const row = await open(
        page,
        pr({
          ci: 'pending',
          behind: false,
          status: CI_BLOCK,
          autoMergeEnabled: true,
          autoMerge: {
            state: 'waiting',
            code: 'checks_pending',
            message: 'Auto-merge is waiting for checks to finish.',
          },
          allowedActions: [
            { action: 'merge', blocked: CI_BLOCK },
            { action: 'cancel_auto_merge' },
            { action: 'close' },
          ],
        }),
      );
      await expect(row.locator('.wait-chip-label')).toHaveText(
        'Waiting for CI',
      );
      await expect(
        row.getByRole('button', { name: 'Merge', exact: true }),
      ).toHaveCount(0);
      await expect(row.locator('[aria-disabled="true"]')).toHaveCount(0);
      await expect(row).not.toContainText('Merge unlocks automatically');
      await axeClean(page);
    });

    test('a block the person can act on keeps its locked button and reason', async ({
      page,
    }) => {
      const row = await open(
        page,
        pr({
          draft: true,
          behind: false,
          status: {
            code: 'draft',
            message: 'Draft pull request',
            next: 'Mark it ready to unlock Merge',
          },
          allowedActions: [
            {
              action: 'merge',
              blocked: {
                code: 'draft',
                message: 'Draft pull request',
                next: 'Mark it ready to unlock Merge',
              },
            },
            { action: 'close' },
          ],
        }),
      );
      await expect(row).toContainText('Draft pull request');
      await expect(
        row.getByRole('button', { name: 'Merge', exact: true }),
      ).toHaveAttribute('aria-disabled', 'true');
    });
  });
}

test('the pop-up keeps its Update branch button while the update is requested', async ({
  page,
}) => {
  await page.route('**/api/v1/pull-requests/update-branch', (route) =>
    route.fulfill({ status: 202 }),
  );
  const row = await open(page, pr());
  await row.getByRole('button', { name: 'Update branch' }).click();
  const dialog = await openActionsDialog(row);
  await expect(
    actionsFooter(dialog).getByRole('button', { name: /Update branch|Queued/ }),
  ).toBeVisible();
});
