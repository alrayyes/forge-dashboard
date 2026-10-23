import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The issue dialog lists the pull requests that will close the issue, drawn
// by the same code as the pill on the issue row. Mocks /api/dashboard and the
// issue details endpoint only and writes no saved state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();
const REPO = 'alrayyes/forge-dashboard';

const none = { passed: 0, running: 0, waiting: 0, failed: 0 };
const linked = (number: number, overrides: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: REPO,
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  ci: 'success',
  checks: { ...none, passed: 3 },
  awaitingWorkflowApproval: false,
  ...overrides,
});

const issue = (number: number, linkedPullRequests: unknown[]) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'ryankes',
  labels: [{ name: 'enhancement' }],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests,
});

async function mockBoard(page: Page, issues: () => unknown[]) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  const snapshot = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: issues(),
      }),
    });
  await page.route('**/api/dashboard/refresh', snapshot);
  await page.route('**/api/dashboard*', snapshot);
  await page.route('**/api/issues/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: 'The issue text.',
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions: {
            thumbsUp: { count: 0, logins: [] },
            thumbsDown: { count: 0, logins: [] },
          },
        },
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
        releaseNotes: null,
        state: 'open',
      }),
    }),
  );
}

const rowPills = (page: Page) =>
  page.locator('#issue-rows .row').first().locator('.linked-pr');
const dialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const dialogPills = (page: Page) => dialog(page).locator('.linked-pr');
const openDialog = (page: Page) =>
  page.locator('#issue-rows .row').first().locator('button.title').click();

test('the dialog shows the closing pull request with the row pill, same name and text', async ({
  page,
}) => {
  await mockBoard(page, () => [issue(1, [linked(12)])]);
  await page.goto('/issues.html');
  await openDialog(page);

  await expect(dialog(page)).toBeVisible();
  await expect(dialogPills(page)).toHaveCount(1);
  const name = await rowPills(page).getAttribute('aria-label');
  await expect(dialogPills(page)).toHaveAttribute('aria-label', name ?? '');
  await expect(dialogPills(page)).toHaveText(
    (await rowPills(page).textContent()) ?? '',
  );
  await expect(dialogPills(page)).toHaveAttribute('href', linked(12).pageUrl);
});

test('an issue nothing closes shows no pills in the dialog', async ({
  page,
}) => {
  await mockBoard(page, () => [issue(1, [])]);
  await page.goto('/issues.html');
  await openDialog(page);

  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.linked-prs')).toHaveCount(0);
});

test('the pills follow the pull request list while the dialog stays open', async ({
  page,
}) => {
  let list: unknown[] = [];
  await mockBoard(page, () => [issue(1, list)]);
  const refresh = () =>
    page.evaluate(() =>
      document.querySelector<HTMLElement>('#force-refresh-button')?.click(),
    );
  await page.goto('/issues.html');
  await openDialog(page);
  await expect(dialog(page)).toBeVisible();
  await expect(dialogPills(page)).toHaveCount(0);

  list = [linked(12)];
  await refresh();
  await expect(dialogPills(page)).toHaveCount(1);
  await expect(dialog(page)).toBeVisible();

  list = [linked(12, { draft: true }), linked(13)];
  await refresh();
  await expect(dialogPills(page)).toHaveCount(2);
  await expect(dialogPills(page).first()).toContainText('draft');

  list = [];
  await refresh();
  await expect(dialogPills(page)).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();
});

for (const width of [1280, 390]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe violations with a closing pull request in the dialog, ${scheme} at ${width}px`, async ({
      page,
    }) => {
      await mockBoard(page, () => [issue(1, [linked(12)])]);
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/issues.html');
      await openDialog(page);
      await expect(dialogPills(page)).toHaveCount(1);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
