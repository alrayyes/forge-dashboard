import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// One test per pop-up call site that hands the dialog `POPUP_CANDIDATES`
// (#4498). The two lists differ only when the Filters button and the Title box
// are both hidden, which is a desktop width with one row left on the page. So
// every test here runs in that state, and swapping any one site's list for
// `ADDRESS_CANDIDATES` changes the id the pop-up is told to try first (the
// attribute) and where focus lands on close.
//
// The seven sites, in Dashboard.svelte:
//   openClosingIssue          a closing-issue pill in a pull request pop-up
//   followReference           a `#N` naming a pull request this page lists
//   followReference           a `#N` naming an issue
//   openLinkedPullRequest     a linked pill, Pull requests page, listed
//   openLinkedPullRequest     a linked pill, Issues page, the board has it
//   openLinkedPullRequest     a linked pill, the board does not have it
//   openAddressedIssue        `?issue=` naming an issue
//
// Mocks /api/v1/dashboard and the details endpoints only and writes no saved
// state.

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
const issue = (
  number: number,
  author: string,
  linkedPullRequests: unknown[] = [],
) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/${REPO}/issues/${number}`,
  author,
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests,
  referencedByPullRequests: [],
});

// Filtered to ryankes, one row is left on each page: pull request 2 and issue
// 6. Pull request 1 and issue 5 are someone else's, so they are the ones the
// address names, and their rows are gone when their pop-ups close. Pull
// request 9 is not on the board at all.
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
      ],
      issues: [
        issue(5, 'someone-else', [linked(1), linked(2), linked(9)]),
        issue(6, 'ryankes'),
      ],
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
            text: 'See #2 and #6 for the background.',
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

// The pop-up is told the Title box, which is hidden here, and the Filters
// button is hidden at this width. `ADDRESS_CANDIDATES` would name a later
// control that is drawn, so the id alone tells the lists apart.
const POPUP_LAST_CANDIDATE = 'title-filter';
// The first control of the bar that is drawn and enabled once both are hidden.
const FIRST_DRAWN_CONTROL = 'shared-author-filter-button';

async function expectPopupFallback(dialog: ReturnType<typeof prDialog>) {
  const page = dialog.page();
  await expect(dialog).toHaveAttribute(
    'data-return-focus-fallback',
    POPUP_LAST_CANDIDATE,
  );
  await closeAndSettle(page);
  await expect(page.locator(`#${FIRST_DRAWN_CONTROL}`)).toBeFocused();
}

test.describe('the pop-up fallback at each call site, both candidates hidden', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
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

  test.describe('the Pull requests page', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/pull-requests.html?pr=github/${REPO}/1`);
      await expect(prDialog(page)).toContainText('Pull request 1');
      await expect(page.locator('#pr-rows .row')).toHaveCount(1);
      await expect(page.locator('#title-filter')).toBeHidden();
    });

    test('a closing-issue pill: the issue pop-up names the Title box and closing lands on the bar', async ({
      page,
    }) => {
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toContainText('Issue 5');

      await expectPopupFallback(issueDialog(page));
    });

    test('a #N naming a listed pull request: its pop-up names the Title box and closing lands on the bar', async ({
      page,
    }) => {
      await prDialog(page)
        .getByRole('link', { name: '#2', exact: true })
        .click();
      await expect(prDialog(page)).toContainText('Pull request 2');

      await expectPopupFallback(prDialog(page));
    });

    test('a #N naming an issue: its pop-up names the Title box and closing lands on the bar', async ({
      page,
    }) => {
      await prDialog(page)
        .getByRole('link', { name: '#6', exact: true })
        .click();
      await expect(issueDialog(page)).toContainText('Issue 6');

      await expectPopupFallback(issueDialog(page));
    });

    test('a linked pill naming a listed pull request: its pop-up names the Title box and closing lands on the bar', async ({
      page,
    }) => {
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toContainText('Issue 5');
      await issueDialog(page).locator('.linked-pr', { hasText: '#2' }).click();
      await expect(prDialog(page)).toContainText('Pull request 2');

      await expectPopupFallback(prDialog(page));
    });
  });

  test.describe('the Issues page', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/issues.html?issue=github/${REPO}/5`);
      await expect(issueDialog(page)).toContainText('Issue 5');
      await expect(page.locator('#issue-rows .row')).toHaveCount(1);
      await expect(page.locator('#title-filter')).toBeHidden();
    });

    test('an issue named in the address: its pop-up names the Title box and closing lands on the bar', async ({
      page,
    }) => {
      await expectPopupFallback(issueDialog(page));
    });

    test('a linked pill naming a pull request the board has: its pop-up names the Title box and closing lands on the bar', async ({
      page,
    }) => {
      await issueDialog(page).locator('.linked-pr', { hasText: '#1' }).click();
      await expect(prDialog(page)).toContainText('Pull request 1');

      await expectPopupFallback(prDialog(page));
    });

    test('a linked pill naming a pull request the board lacks: its pop-up names the Title box and closing lands on the bar', async ({
      page,
    }) => {
      await issueDialog(page).locator('.linked-pr', { hasText: '#9' }).click();
      await expect(issueDialog(page)).toContainText('Pull request #9');

      await expectPopupFallback(issueDialog(page));
    });
  });
});
