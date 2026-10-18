import { expect, type Page, type Route } from '@playwright/test';
import { openActionsDialog } from './actions-dialog-helper';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The helper the specs use to reach a row's actions in its dialog. Mocks
// /api/dashboard and the details endpoint only and writes no per-user state,
// so it starts from the shared session.
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

const now = new Date().toISOString();

function makePR(number: number) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: now,
    updatedAt: now,
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
  };
}

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

async function mock(page: Page) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: now,
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [makePR(42), makePR(43)],
        issues: [],
      }),
    }),
  );
  await page.route('**/api/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: 'The description.',
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions: noReactions,
        },
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
        releaseNotes: null,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
}

const row = (page: Page, n: number) =>
  page.locator('#pr-rows .row', { hasText: `#${n}` });

test.describe('openActionsDialog', () => {
  test.beforeEach(async ({ page }) => {
    await mock(page);
    await expect(row(page, 42)).toBeVisible();
  });

  test("returns the dialog of the row it was given, with that row's content", async ({
    page,
  }) => {
    const dialog = await openActionsDialog(row(page, 43));
    await expect(dialog).toContainText('Pull request 43');
    await expect(dialog).not.toContainText('Pull request 42');
    await expect(
      dialog.getByRole('link', { name: /Open on GitHub/ }),
    ).toHaveAttribute('href', 'https://example.com/43');
  });

  test('the returned scope is the open dialog, hidden again on Escape', async ({
    page,
  }) => {
    const dialog = await openActionsDialog(row(page, 42));
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('focus returns to the row it opened from', async ({ page }) => {
    const dialog = await openActionsDialog(row(page, 42));
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(
      row(page, 42).getByRole('button', { name: /^#42 / }),
    ).toBeFocused();
  });

  test('a second row opens after the first is closed', async ({ page }) => {
    const first = await openActionsDialog(row(page, 42));
    await page.keyboard.press('Escape');
    await expect(first).toBeHidden();
    const second = await openActionsDialog(row(page, 43));
    await expect(second).toContainText('Pull request 43');
  });
});
