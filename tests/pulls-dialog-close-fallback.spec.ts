import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// Where focus lands when the last pop-up closes on the Pull requests page and
// the row that started the chain is filtered out. Two paths hand the pop-up a
// fallback only there, because both are guarded by the Pull requests view: a
// `#N` in a pull request's text that names another listed pull request, and a
// linked-pull-request pill in an issue pop-up that names one. No Issues-page
// journey reaches either, so issues-dialog-close-focus.spec.ts cannot pin them
// (#4468). Mocks /api/v1/dashboard and the details endpoints only and writes
// no saved state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();
const REPO = 'alrayyes/forge-dashboard';
const none = { passed: 0, running: 0, waiting: 0, failed: 0 };

const closing = (number: number) => ({
  repo: REPO,
  number,
  url: `https://example.com/issues/${number}`,
  pageUrl: `/issues.html?issue=github/${REPO}/${number}`,
});
const linked = (number: number) => ({
  forge: 'github',
  repo: REPO,
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  ci: 'success',
  checks: { ...none, passed: 3 },
  awaitingWorkflowApproval: false,
});

const pullRequest = (
  number: number,
  author: string,
  closesIssues: unknown[] = [],
) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/${REPO}/pull/${number}`,
  author,
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(5),
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
  closesIssues,
});
const issue = (number: number, linkedPullRequests: unknown[] = []) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/${REPO}/issues/${number}`,
  author: 'ryankes',
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests,
  referencedByPullRequests: [],
});

// Pull request 1 is the only one someone-else wrote, so a filter on ryankes
// leaves it out while pull requests 2 and 3 stay listed. It closes issue 5,
// which links pull request 2, and its text names pull request 2.
const mockedBoard = (route: Route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: [forgeHealth('github')],
      pullRequests: [
        pullRequest(1, 'someone-else', [closing(5)]),
        pullRequest(2, 'ryankes'),
        pullRequest(3, 'ryankes'),
      ],
      issues: [issue(5, [linked(1), linked(2)]), issue(6)],
    }),
  });

const reactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

async function mockBoard(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', mockedBoard);
  for (const endpoint of ['pull-requests', 'issues'])
    await page.route(`**/api/v1/${endpoint}/details*`, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          description: {
            text: 'See #2 for the background.',
            format: 'markdown',
            truncated: false,
            edited: false,
            reactions,
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

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });

// Closing a dialog takes the browser two steps: it drops `open` and hands
// focus back to what had it before, then it fires `close`, where the dashboard
// moves focus to its own target. Wait for no open dialog and then for a turn of
// the page's event loop (#4351 review).
async function closeAndSettle(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.evaluate(
    () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  );
}

for (const width of [1280, 390]) {
  test.describe(`the Pull requests page at ${width}px`, () => {
    const fallbackId = width === 390 ? 'filters-button' : 'title-filter';

    test.beforeEach(async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: 844 });
      await mockBoard(page);
      await page.context().addCookies([
        {
          name: 'forge-board-filters',
          value: encodeURIComponent(
            JSON.stringify({
              rev: 2_000_000_000,
              shared: { author: 'github:ryankes' },
            }),
          ),
          url: baseURL,
        },
      ]);
    });
    test.afterEach(async ({ context }) => {
      await context.clearCookies({ name: 'forge-board-filters' });
    });

    test('a #N to a listed pull request, the opening row filtered out: closing lands on the fallback control', async ({
      page,
    }) => {
      await page.goto(`/pull-requests.html?pr=github/${REPO}/1`);
      await expect(prDialog(page)).toContainText('Pull request 1');
      await expect(page.locator('#pr-rows .row')).toHaveCount(2);
      await expect(
        page.locator('#pr-rows .row', { hasText: 'Pull request 1' }),
      ).toHaveCount(0);

      await prDialog(page).getByRole('link', { name: '#2' }).click();
      await expect(prDialog(page)).toContainText('Pull request 2');
      await expect(prDialog(page)).toHaveAttribute(
        'data-return-focus-fallback',
        fallbackId,
      );

      await closeAndSettle(page);

      await expect(page.locator(`#${fallbackId}`)).toBeFocused();
    });

    test('a linked pull request pill to a listed pull request, the opening row filtered out: closing lands on the fallback control', async ({
      page,
    }) => {
      await page.goto(`/pull-requests.html?pr=github/${REPO}/1`);
      await expect(prDialog(page)).toContainText('Pull request 1');
      await expect(page.locator('#pr-rows .row')).toHaveCount(2);

      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toContainText('Issue 5');
      await issueDialog(page).locator('.linked-pr', { hasText: '#2' }).click();
      await expect(prDialog(page)).toContainText('Pull request 2');
      await expect(prDialog(page)).toHaveAttribute(
        'data-return-focus-fallback',
        fallbackId,
      );

      await closeAndSettle(page);

      await expect(page.locator(`#${fallbackId}`)).toBeFocused();
    });
  });
}
