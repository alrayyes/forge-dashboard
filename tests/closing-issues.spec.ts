import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A pull request that will close issues shows a pill for each, and the link
// opens that issue's pop-up on the Issues page. Mocks /api/dashboard and the
// details endpoints only and writes no saved state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const REPO = 'alrayyes/forge-dashboard';
const address = (number: number, repo = REPO) =>
  `/issues.html?issue=github/${repo}/${number}`;

const closing = (number: number, repo = REPO) => ({
  repo,
  number,
  url: `https://example.com/${repo}/issues/${number}`,
  pageUrl: address(number, repo),
});

const issue = (number: number) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'ryankes',
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests: [],
});

const pullRequest = (number: number, closesIssues: unknown[]) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Pull request ${number}`,
  url: `https://example.com/pull/${number}`,
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

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const details = {
  description: {
    text: 'The **issue** text.',
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
};

type Board = { pullRequests?: unknown[]; issues?: unknown[] };

async function mockBoard(page: Page, board: Board) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: board.pullRequests ?? [],
        issues: board.issues ?? [],
      }),
    }),
  );
  for (const endpoint of ['pull-requests', 'issues'])
    await page.route(`**/api/${endpoint}/details*`, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(details),
      }),
    );
}

const pills = (page: Page, number: number) =>
  page
    .locator('#pr-rows .row', { hasText: `Pull request ${number}` })
    .locator('.closing-issue');
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });

test.describe('the pill on a pull request row', () => {
  test('shows the issue number, opens it, and says what it is to a screen reader', async ({
    page,
  }) => {
    await mockBoard(page, {
      pullRequests: [pullRequest(1, [closing(12)]), pullRequest(2, [])],
    });
    await page.goto('/pull-requests.html');

    await expect(pills(page, 1)).toHaveCount(1);
    await expect(pills(page, 1)).toHaveText('Closes #12');
    await expect(pills(page, 1)).toHaveAccessibleName(
      'Closes #12, opens the issue',
    );
    await expect(pills(page, 2)).toHaveCount(0);
  });

  test('names the repository when the issue is in another one', async ({
    page,
  }) => {
    await mockBoard(page, {
      pullRequests: [pullRequest(1, [closing(4, 'alrayyes/other')])],
    });
    await page.goto('/pull-requests.html');

    await expect(pills(page, 1)).toHaveText('Closes alrayyes/other#4');
  });

  test('shows two of several and a count that opens the rest', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mockBoard(page, {
      pullRequests: [
        pullRequest(1, [closing(10), closing(11), closing(12), closing(13)]),
      ],
    });
    await page.goto('/pull-requests.html');

    await expect(pills(page, 1)).toHaveCount(2);
    const more = page.getByRole('button', { name: /^2 more/ });
    await expect(more).toHaveAccessibleName(
      '2 more issues that this pull request will close',
    );

    await more.click();

    await expect(pills(page, 1)).toHaveCount(4);
    await expect(pills(page, 1).nth(2)).toBeFocused();
  });

  test('is also in the pull request pop-up', async ({ page }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [closing(12)])] });
    await page.goto('/pull-requests.html');

    await page
      .getByRole('button', { name: /Pull request 1/ })
      .first()
      .click();

    const popup = page.getByRole('dialog', { name: /^Pull request details/ });
    await expect(popup.locator('.closing-issue')).toHaveText('Closes #12');
  });

  test('has no accessibility violations in light, dark and at 390 px', async ({
    page,
  }) => {
    await mockBoard(page, {
      pullRequests: [pullRequest(1, [closing(10), closing(11), closing(12)])],
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/pull-requests.html');
        await expect(pills(page, 1).first()).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations, `${scheme} at ${width}px`).toEqual([]);
      }
    }
  });
});

test.describe('the address of an issue', () => {
  test('opening the address directly still opens it', async ({ page }) => {
    await mockBoard(page, { issues: [issue(12)] });

    await page.goto(address(12));

    await expect(issueDialog(page)).toBeVisible();
    await expect(issueDialog(page).locator('strong')).toHaveText('issue');
  });

  test("closing the pop-up opened from the address puts focus on that issue's title", async ({
    page,
  }) => {
    await mockBoard(page, { issues: [issue(12), issue(13)] });

    await page.goto(address(12));
    await expect(issueDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(issueDialog(page)).toBeHidden();
    await expect(
      page.getByRole('button', { name: '#12 Issue 12' }),
    ).toBeFocused();
  });

  test('closing it when the filters leave the row out puts focus on the first filter, not the page', async ({
    page,
    context,
    baseURL,
  }) => {
    await mockBoard(page, {
      issues: [issue(12), { ...issue(13), author: 'someone-else' }],
    });
    await context.addCookies([
      {
        name: 'forge-board-filters',
        value: encodeURIComponent(
          JSON.stringify({
            rev: 2_000_000_000,
            shared: { author: 'someone-else' },
          }),
        ),
        url: baseURL,
      },
    ]);

    await page.goto(address(12));
    await expect(issueDialog(page)).toBeVisible();
    await expect(
      page.locator('#issue-rows .row', { hasText: 'Issue 12' }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');

    await expect(issueDialog(page)).toBeHidden();
    await expect(page.getByLabel('Filter by title')).toBeFocused();
    await context.clearCookies({ name: 'forge-board-filters' });
  });

  test('a pop-up opened from a row still returns focus to that row', async ({
    page,
  }) => {
    await mockBoard(page, { issues: [issue(12), issue(13)] });
    await page.goto('/issues.html');

    const title = page.getByRole('button', { name: '#13 Issue 13' });
    await title.click();
    await expect(issueDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(title).toBeFocused();
  });

  test('has no axe violations with the pop-up open from the address, or after it closes', async ({
    page,
  }) => {
    await mockBoard(page, { issues: [issue(12)] });

    await page.goto(address(12));
    await expect(issueDialog(page)).toBeVisible();
    const open = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(open.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(issueDialog(page)).toBeHidden();
    const closed = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(closed.violations).toEqual([]);
  });

  test('says plainly when the issue is not on the board', async ({ page }) => {
    await mockBoard(page, { issues: [issue(12)] });

    await page.goto(address(99));

    await expect(issueDialog(page)).toBeHidden();
    await expect(page.locator('#issue-address-note')).toHaveText(
      `Issue ${REPO} #99 is not open any more, is hidden by your settings, or this dashboard does not track it.`,
    );
    await expect(page.locator('#issue-rows .row')).toHaveCount(1);
  });

  test('a malformed address opens nothing', async ({ page }) => {
    await mockBoard(page, { issues: [issue(12)] });

    await page.goto('/issues.html?issue=github/nonsense');

    await expect(page.locator('#issue-rows .row')).toHaveCount(1);
    await expect(issueDialog(page)).toBeHidden();
    await expect(page.locator('#issue-address-note')).toBeHidden();
  });
});
