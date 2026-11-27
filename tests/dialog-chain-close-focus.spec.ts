import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { installFakeStream, pushStream } from './fake-stream-helper';
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

const pullRequest = (
  number: number,
  closesIssues: unknown[] = [],
  author = 'ryankes',
  mentionsIssues: unknown[] = [],
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
  mentionsIssues,
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
        pullRequest(1, [closing(5)], 'someone-else'),
        // Pull request 2 mentions pull request 3, which the forge's mention
        // list marks untracked: only open issues are tracked there.
        pullRequest(2, [closing(5)], 'ryankes', [
          { ...closing(3), tracked: false },
        ]),
        pullRequest(3, [closing(6)]),
      ],
      issues: [
        issue(5, [linked(1), linked(2), linked(9)]),
        issue(6, [linked(3)]),
      ],
    }),
  });

const outgoingToIssue = (number: number) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Item ${number}`,
  url: `https://github.com/${REPO}/issues/${number}`,
  pageUrl: `/issues.html?issue=github/${REPO}/${number}`,
  kind: 'issue',
  state: 'open',
  direction: 'outgoing',
  relation: 'refs',
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
            text:
              endpoint === 'pull-requests'
                ? 'Related to #5.'
                : 'See #3 and #6.',
          },
          state: 'open',
          // Issue 5 refers to issue 6: an outgoing pill in its dialog.
          ...(endpoint === 'issues' &&
          new URL(route.request().url()).searchParams.get('number') === '5'
            ? { references: [outgoingToIssue(6)] }
            : {}),
        }),
      }),
    );
}

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const rowPill = (page: Page, rows: string, text: string, pill: string) =>
  page.locator(`${rows} .row`, { hasText: text }).locator(pill).first();
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

    test('a row pill, its issue, then a pull request pill: closing returns to the row pill', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      const pill = rowPill(
        page,
        '#pr-rows',
        'Pull request 2',
        '.closing-issue',
      );
      await pill.click();
      await expect(issueDialog(page)).toBeVisible();
      await issueDialog(page).locator('.linked-pr', { hasText: '#1' }).click();
      await expect(prDialog(page)).toContainText('Pull request 1');

      await closeAndSettle(page);

      await expect(pill).toBeFocused();
      await expectTitleBoxUntouched(page);
    });

    test('a pull request opened from its address, its row filtered out: closing moves focus off the Title box on a phone', async ({
      page,
      baseURL,
    }) => {
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
      await page.goto(`/pull-requests.html?pr=github/${REPO}/1`);
      await expect(prDialog(page)).toBeVisible();
      await expect(page.locator('#pr-rows .row')).toHaveCount(2);
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toBeVisible();

      await closeAndSettle(page);

      if (width === 390) {
        await expectTitleBoxUntouched(page);
        await expect(page.locator('#filters-button')).toBeFocused();
      } else {
        await expect(page.locator('#title-filter')).toBeFocused();
      }
      await page.context().clearCookies({ name: 'forge-board-filters' });
    });

    test('a #N to a pull request from a chained issue: closing returns to the first pull request', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      const first = rowTitle(page, '#pr-rows', 'Pull request 1');
      await first.click();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toBeVisible();
      await issueDialog(page)
        .getByRole('link', { name: '#3', exact: true })
        .click();
      await expect(prDialog(page)).toContainText('Pull request 3');

      await closeAndSettle(page);

      await expect(first).toBeFocused();
      await expectTitleBoxUntouched(page);
    });

    test('a #N to an issue from a chained issue: closing returns to the first pull request', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      const first = rowTitle(page, '#pr-rows', 'Pull request 3');
      await first.click();
      await prDialog(page).getByRole('link', { name: '#5' }).click();
      await expect(issueDialog(page)).toContainText('Issue 5');
      await issueDialog(page)
        .getByRole('link', { name: '#6', exact: true })
        .click();
      await expect(issueDialog(page)).toContainText('Issue 6');

      await closeAndSettle(page);

      await expect(first).toBeFocused();
      await expectTitleBoxUntouched(page);
    });

    test('an outgoing pill to an issue, mid-chain: closing returns to the first pull request', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      const first = rowTitle(page, '#pr-rows', 'Pull request 1');
      await first.click();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toContainText('Issue 5');
      await issueDialog(page)
        .locator('.related-band .linked-pr', { hasText: '#6' })
        .click();
      await expect(issueDialog(page)).toContainText('Issue 6');

      await closeAndSettle(page);

      await expect(first).toBeFocused();
      await expectTitleBoxUntouched(page);
    });

    test('a pull request the board does not hold, opened from its address, then its issue: closing moves focus off the Title box on a phone', async ({
      page,
    }) => {
      // Only the lookup (includeHidden) knows pull request 9.
      await page.route('**/api/v1/dashboard?includeDrafts=true*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [forgeHealth('github')],
            pullRequests: [pullRequest(9, [closing(5)])],
            issues: [issue(5)],
          }),
        }),
      );
      await page.goto(`/pull-requests.html?pr=github/${REPO}/9`);
      await expect(prDialog(page)).toContainText('Pull request 9');
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toBeVisible();

      await closeAndSettle(page);

      if (width === 390) {
        await expectTitleBoxUntouched(page);
        await expect(page.locator('#filters-button')).toBeFocused();
      } else {
        await expect(page.locator('#title-filter')).toBeFocused();
      }
    });

    test("an opener row a refresh removed, one row left and no filter: closing lands on that row's title (#4464)", async ({
      page,
    }) => {
      await installFakeStream(page);
      await page.goto('/issues.html');
      await rowTitle(page, '#issue-rows', 'Issue 5').click();
      await issueDialog(page)
        .locator('.related-band .linked-pr', { hasText: '#6' })
        .click();
      await expect(issueDialog(page)).toContainText('Issue 6');

      // One row and no filter hide the whole filter bar (#3823), and the row
      // the dialog opened from is gone, so nothing the pop-up remembers is
      // drawn. The one row's title button is the control left to land on.
      await pushStream(page, {
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [pullRequest(3, [closing(6)])],
        issues: [issue(6, [linked(3)])],
      });
      await expect(page.locator('#issue-rows .row')).toHaveCount(1);
      await expect(page.locator('.filter-bar')).toBeHidden();

      await closeAndSettle(page);

      await expect(rowTitle(page, '#issue-rows', 'Issue 6')).toBeFocused();
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        const axe = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(axe.violations, colorScheme).toEqual([]);
      }
    });

    test("the same on the pull requests page: one row left, no filter, closing lands on that row's title (#4464)", async ({
      page,
    }) => {
      await installFakeStream(page);
      await page.goto('/pull-requests.html');
      await rowTitle(page, '#pr-rows', 'Pull request 1').click();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toContainText('Issue 5');

      await pushStream(page, {
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [pullRequest(3, [closing(6)])],
        issues: [issue(6, [linked(3)])],
      });
      await expect(page.locator('#pr-rows .row')).toHaveCount(1);
      await expect(page.locator('.filter-bar')).toBeHidden();

      await closeAndSettle(page);

      await expect(rowTitle(page, '#pr-rows', 'Pull request 3')).toBeFocused();
    });

    test('a read-only pull request opened from a row pill after a chain ended swaps back to that pill', async ({
      page,
    }) => {
      await page.goto('/issues.html');
      await rowTitle(page, '#issue-rows', 'Issue 5').click();
      await issueDialog(page).locator('.linked-pr', { hasText: '#1' }).click();
      await expect(prDialog(page)).toBeVisible();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toBeVisible();
      await closeAndSettle(page);

      // The first chain is over. A pill on another row opens a pull request
      // the Issues page can only show read only; its own swap is a new one.
      const pill = rowPill(page, '#issue-rows', 'Issue 6', '.linked-pr');
      await pill.click();
      await expect(prDialog(page)).toContainText('Pull request 3');
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toContainText('Issue 6');
      await closeAndSettle(page);

      await expect(pill).toBeFocused();
    });

    test('a single swap from the control a chain ended on returns where a fresh page does', async ({
      page,
    }) => {
      // The chain is cleared when the next dialog opens, not when its last one
      // closes, so it can outlive its close. A swap from the very control it
      // ended on must not behave differently for that: both runs below end on
      // the row pill, as a page that never had a chain does.
      const pill = () => rowPill(page, '#issue-rows', 'Issue 5', '.linked-pr');
      const swapOnce = async () => {
        await pill().click();
        await expect(prDialog(page)).toBeVisible();
        await prDialog(page).locator('.closing-issue').first().click();
        await expect(issueDialog(page)).toBeVisible();
        await closeAndSettle(page);
        await expect(pill()).toBeFocused();
        await expectTitleBoxUntouched(page);
      };
      await page.goto('/issues.html');
      await swapOnce();

      // A chain of two swaps that ends on the same pill, then the single swap.
      await rowTitle(page, '#issue-rows', 'Issue 5').click();
      await issueDialog(page).locator('.linked-pr', { hasText: '#1' }).click();
      await expect(prDialog(page)).toBeVisible();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toBeVisible();
      await closeAndSettle(page);
      await expect(pill()).toBeFocused();
      await swapOnce();
    });

    test('a mention pill for a pull request the board holds, mid-chain: closing returns to the first pull request', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      const first = rowTitle(page, '#pr-rows', 'Pull request 1');
      await first.click();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toBeVisible();
      await issueDialog(page).locator('.linked-pr', { hasText: '#2' }).click();
      await expect(prDialog(page)).toContainText('Pull request 2');

      await prDialog(page).locator('.mention-pill').click();
      await expect(prDialog(page)).toContainText('Pull request 3');

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

    test('a chain ended by a pull request the board does not hold leaves nothing behind', async ({
      page,
    }) => {
      // Pull request 1, its issue, then a pill for a pull request the board
      // does not hold: a pop-up stays up for it (#4477), and closing it
      // ends the chain.
      await page.goto('/pull-requests.html');
      await rowTitle(page, '#pr-rows', 'Pull request 1').click();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toBeVisible();
      await issueDialog(page).locator('.linked-pr', { hasText: '#9' }).click();
      await expect(page.locator('dialog[open]')).toHaveCount(1);
      await closeAndSettle(page);
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
