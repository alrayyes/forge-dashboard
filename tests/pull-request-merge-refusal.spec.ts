import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

// The merge endpoint answers a refused merge with a structured result
// (components.schemas.ActionError): a `code` and a short `message`. These
// tests mock that response and check the row and toast render it. The
// code decisions themselves are tested in Go (internal/dashboard).

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

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `pr-merge-refusal-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'PR Merge Refusal User',
  );
}

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

test.describe('a refused merge explains itself from the server code', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
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
    await page.reload();

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
    await page.reload();

    await confirmMerge(page);

    await expect(page.locator('#pr-rows .row')).toHaveCount(0);
    await expect(page.locator('#feedback-toasts')).toContainText(
      /already merged/i,
    );
  });

  test('already_closed: the row reads Closed', async ({ page }) => {
    const pr = makePR();
    await mockBoard(page, [pr]);
    await mockRefresh(page, [pr]);
    await refuse(page, 409, {
      error: 'x',
      code: 'already_closed',
      message: 'This pull request was closed without merging.',
    });
    await page.reload();

    const row = await confirmMerge(page);

    await expect(row.locator('.row-settled')).toHaveText('Closed');
    await expect(page.locator('#feedback-toasts')).toContainText(
      /already closed/i,
    );
  });

  test('an earlier failure line on the row clears once the PR is found merged', async ({
    page,
  }) => {
    const pr = makePR();
    await mockBoard(page, [pr]);
    await mockRefresh(page, [pr]);
    await refuse(page, 502, {
      error: 'github: PUT .../merge: EOF',
      code: 'unknown',
      message: 'EOF',
    });
    await page.reload();
    const row = await confirmMerge(page);
    await expect(row.locator('.row-feedback')).toContainText('Failed');

    await page.unroute('**/api/pull-requests/merge');
    await refuse(page, 409, {
      error: 'x',
      code: 'already_merged',
      message: 'This pull request was already merged.',
    });
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    await expect(row.locator('.row-settled')).toHaveText('Merged');
    await expect(row.locator('.row-feedback')).toHaveCount(0);
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
    await page.reload();

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
    await page.reload();

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
    await page.reload();

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

  test('permission: locks Merge and points to Settings', async ({ page }) => {
    await mockBoard(page, [makePR()]);
    await refuse(page, 403, {
      error: 'github: PUT .../merge: Forbidden',
      code: 'permission',
      message: 'Missing permission — check your token in Settings.',
    });
    await page.reload();

    const row = await confirmMerge(page);

    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveAccessibleDescription(/token in Settings/);
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
    await page.reload();

    const row = await confirmMerge(page);

    await expect(row.locator('.row-feedback')).toContainText('EOF');
    const button = row.getByRole('button', { name: 'Merge', exact: true });
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('a refusal with no code (an old backend, a proxy page) is treated as unknown and never says only "merge failed"', async ({
    page,
  }) => {
    await mockBoard(page, [makePR()]);
    await refuse(page, 409, {
      error: 'github: PUT .../merge: Pull Request is not mergeable',
    });
    await page.reload();

    const row = await confirmMerge(page);

    await expect(row.locator('.row-feedback')).toContainText(
      'Pull Request is not mergeable',
    );
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toBeEnabled();
  });

  test('a Merged row has no axe-core violations', async ({ page }) => {
    const pr = makePR();
    await mockBoard(page, [pr]);
    await mockRefresh(page, [pr]);
    await refuse(page, 409, {
      error: 'x',
      code: 'already_merged',
      message: 'This pull request was already merged.',
    });
    await page.reload();

    const row = await confirmMerge(page);
    await expect(row.locator('.row-settled')).toBeVisible();
    await expect(
      page.locator('#feedback-toasts .feedback-toast'),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a refused row has no axe-core violations', async ({ page }) => {
    await mockBoard(page, [makePR()]);
    await refuse(page, 409, {
      error: 'x',
      code: 'conflict',
      message: 'Merge conflict. Resolve it on the forge, then merge.',
    });
    await page.reload();

    const row = await confirmMerge(page);
    await expect(row.locator('.row-feedback')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
