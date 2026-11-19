import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// Dialogs chained through their pills (pull request, issue, pull request, or
// the other way round) swap in one dialog at a time. Closing the last one must
// give focus back to the control that opened the first, not to the Title box,
// which opens its suggestion list on a phone (#4351). Mocks /api/v1/dashboard
// and the details endpoints only and writes no saved state.

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

const pullRequest = (number: number, closesIssues: unknown[] = []) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/${REPO}/pull/${number}`,
  author: 'ryankes',
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

const reactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const details = {
  description: {
    text: 'The text.',
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
};

// Pull request 1 closes issue 5, which pull request 2 closes. Issue 5 also
// links pull request 9, which the board does not hold. Issue 6 is the second
// issue row, so the Title box is drawn on the Issues page too.
const mockedBoard = (route: Route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: [forgeHealth('github')],
      pullRequests: [
        pullRequest(1, [closing(5)]),
        pullRequest(2, [closing(5)]),
        pullRequest(3, [closing(6)]),
      ],
      issues: [
        issue(5, [linked(1), linked(2), linked(9)]),
        issue(6, [linked(3)]),
      ],
    }),
  });

async function mockBoard(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', mockedBoard);
  for (const endpoint of ['pull-requests', 'issues'])
    await page.route(`**/api/v1/${endpoint}/details*`, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...details,
          description: {
            ...details.description,
            text: endpoint === 'pull-requests' ? 'Related to #5.' : 'The text.',
          },
          state: 'open',
        }),
      }),
    );
}

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const rowTitle = (page: Page, rows: string, text: string): Locator =>
  page.locator(`${rows} .row`, { hasText: text }).locator('button.title');

// The Title box opens its suggestion list when it takes focus, and a datalist
// has no DOM to look at, so "the list is closed" is "the box never took focus".
async function expectTitleBoxUntouched(page: Page) {
  const state = await page.evaluate(() => {
    const box = document.getElementById('title-filter') as HTMLInputElement;
    return { focused: document.activeElement === box, value: box.value };
  });
  expect(state).toEqual({ focused: false, value: '' });
}

// Closing a dialog takes the browser two steps: it drops `open` and hands
// focus back to whatever had it before, then it fires `close`, which is where
// the dashboard moves focus to its own target. A focus check between the two
// sees the browser's answer, not ours (#4351 review), so wait for no open
// dialog and then for a turn of the page's event loop.
async function closeAndSettle(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.evaluate(
    () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  );
}

for (const width of [1280, 390]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await mockBoard(page);
    });

    test('pull request, issue, pull request: closing returns to the first pull request', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      const first = rowTitle(page, '#pr-rows', 'Pull request 1');
      await first.click();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toBeVisible();
      await issueDialog(page).locator('.linked-pr', { hasText: '#2' }).click();
      await expect(prDialog(page)).toBeVisible();
      await expect(prDialog(page)).toContainText('Pull request 2');

      await closeAndSettle(page);

      await expect(first).toBeFocused();
      await expectTitleBoxUntouched(page);
    });

    test('issue, pull request, issue: closing returns to where the first swap sent it, the row pill', async ({
      page,
    }) => {
      await page.goto('/issues.html');
      await rowTitle(page, '#issue-rows', 'Issue 5').click();
      await issueDialog(page).locator('.linked-pr', { hasText: '#1' }).click();
      await expect(prDialog(page)).toBeVisible();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toBeVisible();

      await closeAndSettle(page);

      // The same place the single swap to the pull request returns to.
      await expect(
        page
          .locator('#issue-rows .row', { hasText: 'Issue 5' })
          .locator('.linked-pr', { hasText: '#1' }),
      ).toBeFocused();
      await expectTitleBoxUntouched(page);
    });

    test('a #5 in the text, then a pill: closing returns to the first pull request', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      const first = rowTitle(page, '#pr-rows', 'Pull request 3');
      await first.click();
      await prDialog(page).getByRole('link', { name: '#5' }).click();
      await expect(issueDialog(page)).toBeVisible();
      await issueDialog(page).locator('.linked-pr', { hasText: '#2' }).click();
      await expect(prDialog(page)).toContainText('Pull request 2');

      await closeAndSettle(page);

      await expect(first).toBeFocused();
      await expectTitleBoxUntouched(page);
    });

    test('a chain that ended leaves nothing behind for the next swap', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      const first = rowTitle(page, '#pr-rows', 'Pull request 1');
      await first.click();
      await prDialog(page).locator('.closing-issue').first().click();
      await issueDialog(page).locator('.linked-pr', { hasText: '#2' }).click();
      await expect(prDialog(page)).toContainText('Pull request 2');
      await closeAndSettle(page);
      await expect(first).toBeFocused();

      // A new dialog from another row swaps once: it returns to its own row.
      const other = rowTitle(page, '#pr-rows', 'Pull request 2');
      await other.click();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toBeVisible();
      await closeAndSettle(page);

      await expect(other).toBeFocused();
    });

    test('a chain cut short by a lookup that found nothing leaves nothing behind', async ({
      page,
    }) => {
      // Pull request 1, its issue, then a pill for a pull request the board
      // does not hold: the "not found" note shows and the chain is over.
      await page.goto('/pull-requests.html');
      await rowTitle(page, '#pr-rows', 'Pull request 1').click();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toBeVisible();
      await issueDialog(page).locator('.linked-pr', { hasText: '#9' }).click();
      await expect(
        page.getByRole('status').filter({ hasText: '#9' }),
      ).toContainText('not open any more');
      await expect(page.locator('dialog[open]')).toHaveCount(0);

      const third = rowTitle(page, '#pr-rows', 'Pull request 3');
      await third.click();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toBeVisible();
      await closeAndSettle(page);

      await expect(third).toBeFocused();
    });

    test('a lookup still pending when another dialog opens does not steer that dialog', async ({
      page,
    }) => {
      await page.route(
        '**/api/v1/dashboard?includeDrafts=true*',
        async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await mockedBoard(route);
        },
      );
      await page.goto('/issues.html');
      await rowTitle(page, '#issue-rows', 'Issue 5').click();
      await issueDialog(page).locator('.linked-pr', { hasText: '#9' }).click();
      await expect(page.locator('dialog[open]')).toHaveCount(0);

      // The answer is still on its way; the reader opens Issue 6 meanwhile.
      await rowTitle(page, '#issue-rows', 'Issue 6').click();
      const pill = page
        .locator('#issue-rows .row', { hasText: 'Issue 6' })
        .locator('.linked-pr', { hasText: '#3' });
      await issueDialog(page).locator('.linked-pr', { hasText: '#3' }).click();
      await expect(prDialog(page)).toBeVisible();
      await closeAndSettle(page);

      await expect(pill).toBeFocused();
    });

    for (const scheme of ['light', 'dark'] as const) {
      test(`has no axe violations on the last dialog of the chain, ${scheme}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/pull-requests.html');
        await rowTitle(page, '#pr-rows', 'Pull request 1').click();
        await prDialog(page).locator('.closing-issue').first().click();
        await issueDialog(page)
          .locator('.linked-pr', { hasText: '#2' })
          .click();
        await expect(prDialog(page)).toContainText('Pull request 2');

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);

        await closeAndSettle(page);
        const after = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(after.violations).toEqual([]);
      });
    }
  });
}
