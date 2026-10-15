import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The merge endpoint answers a refused merge with a structured result
// (components.schemas.ActionError): a `code` and a short `message`. These
// tests mock that response and check the row and toast render it. The
// code decisions themselves are tested in Go (internal/dashboard).
//
// What Merge shares with every other action is not repeated here: it relies on
// Close's full set in pull-request-action-refusals.spec.ts for already_closed,
// permission, a refusal with no code, an earlier failure line clearing, and the
// axe scan of a Merged row. A settled row is item-level, not action-level, so
// that scan sees the same markup; if it ever becomes action-specific, scan it
// here too (#1380).

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
}

const REPO = 'alrayyes/forge-dashboard';

function makePR(): MockPR {
  return {
    forge: 'github',
    repo: REPO,
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
  };
}

function snapshot(prs: MockPR[]) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: prs,
    issues: [],
  });
}

function mockBoard(page: Page, prs: MockPR[]) {
  return page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(prs),
    }),
  );
}

function mockRefresh(page: Page, prs: MockPR[]) {
  return page.route('**/api/dashboard/refresh', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(prs),
    }),
  );
}

function refuse(page: Page, status: number, body: Record<string, unknown>) {
  return page.route('**/api/pull-requests/merge', (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
}

async function confirmMerge(page: Page) {
  const row = page.locator('#pr-rows .row').first();
  await row.getByRole('button', { name: 'Merge' }).click();
  await row.getByRole('button', { name: 'Confirm merge?' }).click();
  return row;
}

// Every endpoint is mocked and nothing is saved per user, so the whole file
// starts from the shared session (#1379).
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

test.describe('a refused merge explains itself from the server code', () => {
  test.beforeEach(async ({ page }) => {
    // The live stream isn't part of these tests: aborted, so no real snapshot
    // is pushed over the mock.
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
  });

  test('already_merged: the row reads Merged, a polite toast says so, and the row is gone on the next snapshot', async ({
    page,
  }) => {
    const pr = makePR();
    await mockBoard(page, [pr]);
    // The forge still lists the PR open for a moment (the lag in #750).
    await mockRefresh(page, [pr]);
    await refuse(page, 409, {
      error: 'github: PUT .../merge: Pull Request is not mergeable',
      code: 'already_merged',
      message: 'This pull request was already merged.',
    });
    await page.goto('/pull-requests.html');

    const row = await confirmMerge(page);

    await expect(row.locator('.row-settled')).toHaveText('Merged');
    await expect(row.getByRole('button', { name: 'Merge' })).toHaveCount(0);
    const toast = page.locator('#feedback-toasts .feedback-toast');
    await expect(toast).toContainText(`${REPO}#42`);
    await expect(toast).toContainText(/already merged/i);
    await expect(toast).toHaveAttribute('data-kind', 'success');
    await expect(row.locator('.row-feedback')).toHaveCount(0);
    await expect(page.locator('#error-banner')).toHaveCount(0);
  });

  test('already_merged: the row drops off straight away when the refresh shows it gone', async ({
    page,
  }) => {
    await mockBoard(page, [makePR()]);
    await mockRefresh(page, []);
    await refuse(page, 409, {
      error: 'x',
      code: 'already_merged',
      message: 'This pull request was already merged.',
    });
    await page.goto('/pull-requests.html');

    await confirmMerge(page);

    await expect(page.locator('#pr-rows .row')).toHaveCount(0);
    await expect(page.locator('#feedback-toasts')).toContainText(
      /already merged/i,
    );
  });

  test('conflict: the server reason shows on the row and in an error toast', async ({
    page,
  }) => {
    await mockBoard(page, [makePR()]);
    await refuse(page, 409, {
      error: 'github: PUT .../merge: Pull Request is not mergeable',
      code: 'conflict',
      message: 'Merge conflict. Resolve it on the forge, then merge.',
    });
    await page.goto('/pull-requests.html');

    const row = await confirmMerge(page);

    await expect(row.locator('.row-feedback')).toContainText(
      'Merge conflict. Resolve it on the forge, then merge.',
    );
    const toast = page.locator(
      '#feedback-toasts .feedback-toast[data-kind="error"]',
    );
    await expect(toast).toContainText(
      'Merge conflict. Resolve it on the forge',
    );
    await expect(row.locator('.row-settled')).toHaveCount(0);
  });

  test('blocked_by_protection: the server reason shows and Merge is locked until a re-check', async ({
    page,
  }) => {
    await mockBoard(page, [makePR()]);
    await refuse(page, 409, {
      error: 'x',
      code: 'blocked_by_protection',
      message:
        'Blocked by branch protection: a required review or check is missing.',
    });
    await page.goto('/pull-requests.html');

    const row = await confirmMerge(page);

    await expect(row.locator('.row-feedback')).toContainText(
      'Blocked by branch protection',
    );
    // Locked: the only button is a Retry that re-checks, not a second merge.
    await expect(row.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Merge' })).toHaveCount(0);
  });

  test('rate_limited: locks Merge with no Retry and says when it resets, from resetsAt', async ({
    page,
  }) => {
    await mockBoard(page, [makePR()]);
    await refuse(page, 429, {
      error: 'github: rate limit exceeded',
      code: 'rate_limited',
      message:
        "The forge's API rate limit is reached. Try again once it resets.",
      resetsAt: new Date(Date.now() + 20 * 60000).toISOString(),
    });
    await page.goto('/pull-requests.html');

    const row = await confirmMerge(page);

    const button = row.getByRole('button', { name: 'Merge', exact: true });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(button).toHaveAccessibleDescription(/rate limit reached/i);
    await expect(button).toHaveAccessibleDescription(/in \d+ min/);
    await expect(
      page.locator('#feedback-toasts .feedback-toast[data-kind="error"]'),
    ).toBeVisible();
  });

  test('unknown: shows the forge text and keeps Merge clickable', async ({
    page,
  }) => {
    await mockBoard(page, [makePR()]);
    await refuse(page, 502, {
      error: 'github: PUT .../merge: EOF',
      code: 'unknown',
      message: 'EOF',
    });
    await page.goto('/pull-requests.html');

    const row = await confirmMerge(page);

    await expect(row.locator('.row-feedback')).toContainText('EOF');
    const button = row.getByRole('button', { name: 'Merge', exact: true });
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('a refused row has no axe-core violations', async ({ page }) => {
    await mockBoard(page, [makePR()]);
    await refuse(page, 409, {
      error: 'x',
      code: 'conflict',
      message: 'Merge conflict. Resolve it on the forge, then merge.',
    });
    await page.goto('/pull-requests.html');

    const row = await confirmMerge(page);
    await expect(row.locator('.row-feedback')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
