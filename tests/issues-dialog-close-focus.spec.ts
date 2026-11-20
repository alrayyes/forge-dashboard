import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { installFakeStream, pushStream } from './fake-stream-helper';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// Where focus lands when the last pop-up opened on the Issues page closes: for
// an issue named in the address whose row is filtered out, for an in-text
// reference followed from a pop-up, for a chain of four, and for a chain whose
// opening row a poll removed. Each path hands the pop-up a fallback
// (`drawnFallback(POPUP_CANDIDATES)`) and the pop-up re-checks every candidate at close
// time, so a stale id costs one skipped candidate and never the page (#4417).
// Companion to dialog-chain-close-focus.spec.ts, which drives the pull request
// side. Mocks /api/v1/dashboard and the details endpoints only and writes no
// saved state.

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
const issue = (
  number: number,
  linkedPullRequests: unknown[] = [],
  author = 'someone-else',
) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/${REPO}/issues/${number}`,
  author,
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(number),
  linkedPullRequests,
  referencedByPullRequests: [],
});

// Issue 5 links pull request 1, which closes issue 7; issue 7 links pull
// request 4, which closes issue 8. That is the four pop-ups of a chain. Issue 9
// is the only one ryankes filed, so a filter on someone-else leaves it out.
const snapshot = (issues: unknown[]) => ({
  generatedAt: new Date().toISOString(),
  forges: [forgeHealth('github')],
  pullRequests: [pullRequest(1, [closing(7)]), pullRequest(4, [closing(8)])],
  issues,
});
const everyIssue = () => [
  issue(5, [linked(1)]),
  issue(6),
  issue(7, [linked(4)]),
  issue(8),
  issue(9, [linked(1)], 'ryankes'),
];

// What each pop-up's text says, so a `#N` in it is a reference to follow.
const TEXT: Record<string, string> = {
  'issues/5': 'See #6 for the background.',
  'issues/9': 'Related to #6.',
  'issues/6': 'And #7 after that.',
  'pull-requests/1': 'Follow up in #8.',
};

const reactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

async function mockBoard(page: Page, issues = everyIssue()) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(issues)),
    }),
  );
  for (const endpoint of ['pull-requests', 'issues'])
    await page.route(`**/api/v1/${endpoint}/details*`, (route: Route) => {
      const number = new URL(route.request().url()).searchParams.get('number');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          description: {
            text: TEXT[`${endpoint}/${number}`] ?? 'The text.',
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
      });
    });
}

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const row = (page: Page, text: string): Locator =>
  page.locator('#issue-rows .row', { hasText: text });
const rowTitle = (page: Page, text: string) =>
  row(page, text).locator('button.title');
const rowPill = (page: Page, text: string, pill: string) =>
  row(page, text).locator('.linked-pr', { hasText: pill });

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

// The control the fallback names: the Filters button on a phone, the Title box
// elsewhere.
const fallbackControl = (page: Page, width: number) =>
  page.locator(width === 390 ? '#filters-button' : '#title-filter');

// What has focus: not the page, and a control of the filter bar that is drawn
// and enabled (a disabled one cannot take focus). With one row left the Title
// box is hidden, so the pop-up falls through to the first drawn control of the
// bar: the Filters button on a phone, the Author filter elsewhere.
async function focusedControl(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    return {
      id: active?.id ?? '',
      body: active === document.body,
      inBar: Boolean(active?.closest('.filter-bar')),
      drawn: (active?.getClientRects().length ?? 0) > 0,
      disabled: (active as HTMLButtonElement | null)?.disabled ?? false,
    };
  });
}

async function filterOutIssueNine(page: Page, baseURL: string | undefined) {
  await page.context().addCookies([
    {
      name: 'forge-board-filters',
      value: encodeURIComponent(
        JSON.stringify({
          rev: 2_000_000_000,
          shared: { author: 'github:someone-else' },
        }),
      ),
      url: baseURL,
    },
  ]);
}

for (const width of [1280, 390]) {
  test.describe(`the Issues page at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
    });
    test.afterEach(async ({ context }) => {
      await context.clearCookies({ name: 'forge-board-filters' });
    });

    test('an issue named in the address, its row filtered out: closing lands on the fallback control', async ({
      page,
      baseURL,
    }) => {
      await mockBoard(page);
      await filterOutIssueNine(page, baseURL);

      await page.goto(`/issues.html?issue=github/${REPO}/9`);
      await expect(issueDialog(page)).toBeVisible();
      await expect(page.locator('#issue-rows .row')).toHaveCount(4);
      await expect(row(page, 'Issue 9')).toHaveCount(0);
      await expect(issueDialog(page)).toHaveAttribute(
        'data-return-focus-fallback',
        width === 390 ? 'filters-button' : 'title-filter',
      );

      await closeAndSettle(page);

      await expect(fallbackControl(page, width)).toBeFocused();
    });

    test('an issue named in the address, its row filtered out, then a #N: closing lands on the fallback control', async ({
      page,
      baseURL,
    }) => {
      await mockBoard(page);
      await filterOutIssueNine(page, baseURL);

      await page.goto(`/issues.html?issue=github/${REPO}/9`);
      await issueDialog(page).getByRole('link', { name: '#6' }).click();
      await expect(issueDialog(page)).toContainText('Issue 6');
      await expect(issueDialog(page)).toHaveAttribute(
        'data-return-focus-fallback',
        width === 390 ? 'filters-button' : 'title-filter',
      );

      await closeAndSettle(page);

      await expect(fallbackControl(page, width)).toBeFocused();
    });

    test('an issue named in the address, its row filtered out, then a pull request: closing lands on the fallback control', async ({
      page,
      baseURL,
    }) => {
      await mockBoard(page);
      await filterOutIssueNine(page, baseURL);

      await page.goto(`/issues.html?issue=github/${REPO}/9`);
      await issueDialog(page).locator('.linked-pr', { hasText: '#1' }).click();
      await expect(prDialog(page)).toContainText('Pull request 1');

      await closeAndSettle(page);

      await expect(fallbackControl(page, width)).toBeFocused();
    });

    test('an issue named in the address, then a pull request, one filtered row on the page: closing lands on a drawn control of the filter bar', async ({
      page,
      baseURL,
    }) => {
      await mockBoard(page, [
        issue(7, [linked(4)]),
        issue(9, [linked(1)], 'ryankes'),
      ]);
      await filterOutIssueNine(page, baseURL);

      await page.goto(`/issues.html?issue=github/${REPO}/9`);
      await issueDialog(page).locator('.linked-pr', { hasText: '#1' }).click();
      await expect(prDialog(page)).toContainText('Pull request 1');
      // The Title box is hidden over one row, and the pop-up is told which
      // control to try first all the same.
      await expect(prDialog(page)).toHaveAttribute(
        'data-return-focus-fallback',
        width === 390 ? 'filters-button' : 'title-filter',
      );

      await closeAndSettle(page);

      expect(await focusedControl(page)).toEqual({
        id: width === 390 ? 'filters-button' : 'shared-author-filter-button',
        body: false,
        inBar: true,
        drawn: true,
        disabled: false,
      });
    });

    test('an issue named in the address, its row filtered out, then a pull request and its issue: closing lands on the fallback control', async ({
      page,
      baseURL,
    }) => {
      await mockBoard(page);
      await filterOutIssueNine(page, baseURL);

      await page.goto(`/issues.html?issue=github/${REPO}/9`);
      await issueDialog(page).locator('.linked-pr', { hasText: '#1' }).click();
      await expect(prDialog(page)).toContainText('Pull request 1');
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toContainText('Issue 7');

      await closeAndSettle(page);

      await expect(fallbackControl(page, width)).toBeFocused();
    });

    test('an issue named in the address, its row drawn: closing returns to its title', async ({
      page,
    }) => {
      await mockBoard(page);

      await page.goto(`/issues.html?issue=github/${REPO}/6`);
      await expect(issueDialog(page)).toBeVisible();

      await closeAndSettle(page);

      await expect(rowTitle(page, 'Issue 6')).toBeFocused();
    });

    test('a #N followed to an issue and on to another: closing returns to the first trigger', async ({
      page,
    }) => {
      await mockBoard(page);
      await page.goto('/issues.html');
      const first = rowTitle(page, 'Issue 5');
      await first.click();
      await issueDialog(page).getByRole('link', { name: '#6' }).click();
      await expect(issueDialog(page)).toContainText('Issue 6');
      await issueDialog(page).getByRole('link', { name: '#7' }).click();
      await expect(issueDialog(page)).toContainText('Issue 7');

      await closeAndSettle(page);

      await expect(first).toBeFocused();
    });

    test('a pull request from a pill, then a #N to an issue: closing returns to the pill', async ({
      page,
    }) => {
      await mockBoard(page);
      await page.goto('/issues.html');
      await rowTitle(page, 'Issue 5').click();
      await issueDialog(page).locator('.linked-pr', { hasText: '#1' }).click();
      await expect(prDialog(page)).toBeVisible();
      await prDialog(page).getByRole('link', { name: '#8' }).click();
      await expect(issueDialog(page)).toContainText('Issue 8');

      await closeAndSettle(page);

      await expect(rowPill(page, 'Issue 5', '#1')).toBeFocused();
    });

    test('a chain of four pop-ups: closing the fourth returns to the first trigger', async ({
      page,
    }) => {
      await mockBoard(page);
      await page.goto('/issues.html');
      const first = rowPill(page, 'Issue 5', '#1');
      await first.click();
      await expect(prDialog(page)).toContainText('Pull request 1');
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toContainText('Issue 7');
      await issueDialog(page).locator('.linked-pr', { hasText: '#4' }).click();
      await expect(prDialog(page)).toContainText('Pull request 4');
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toContainText('Issue 8');

      await closeAndSettle(page);

      await expect(first).toBeFocused();
    });

    test('a chain whose opening row a poll removed: closing lands on the fallback control', async ({
      page,
    }) => {
      await installFakeStream(page);
      await mockBoard(page);
      await page.goto('/issues.html');
      await rowPill(page, 'Issue 5', '#1').click();
      await expect(prDialog(page)).toBeVisible();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toContainText('Issue 7');
      await issueDialog(page).locator('.linked-pr', { hasText: '#4' }).click();
      await expect(prDialog(page)).toContainText('Pull request 4');
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toContainText('Issue 8');

      // Issue 5, where the chain began, is gone from the next snapshot.
      await pushStream(
        page,
        snapshot(everyIssue().filter((i) => i.number !== 5)),
      );
      await expect(row(page, 'Issue 5')).toHaveCount(0);
      await expect(issueDialog(page)).toBeVisible();

      await closeAndSettle(page);

      await expect(fallbackControl(page, width)).toBeFocused();
    });

    test('a chain whose poll left one filtered row: closing lands on a drawn control of the filter bar', async ({
      page,
      baseURL,
    }) => {
      await installFakeStream(page);
      await mockBoard(page);
      await filterOutIssueNine(page, baseURL);
      await page.goto('/issues.html');
      await rowPill(page, 'Issue 5', '#1').click();
      await expect(prDialog(page)).toBeVisible();
      await prDialog(page).locator('.closing-issue').first().click();
      await expect(issueDialog(page)).toContainText('Issue 7');

      // One row left hides the Title box (#3823) while the active filter keeps
      // the bar drawn: the fallback names a control that exists but is not
      // drawn, so the pop-up has to look past it. (With no filter the whole bar
      // is hidden and there is nothing to land on: #4464.)
      await pushStream(
        page,
        snapshot([issue(7, [linked(4)]), issue(9, [linked(1)], 'ryankes')]),
      );
      await expect(page.locator('#issue-rows .row')).toHaveCount(1);
      await expect(page.locator('#title-filter')).toBeHidden();

      await closeAndSettle(page);

      expect(await focusedControl(page)).toEqual({
        id: width === 390 ? 'filters-button' : 'shared-author-filter-button',
        body: false,
        inBar: true,
        drawn: true,
        disabled: false,
      });
    });
  });
}
