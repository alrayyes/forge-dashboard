import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A pull request's dialog lists the tickets it mentions without closing, and
// a ticket's dialog lists the pull requests that mention it. The server reads
// the text, so these mock /api/v1/dashboard with the fields it returns and only
// check what the page draws. Writes no saved state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();
const REPO = 'alrayyes/forge-dashboard';

const mention = (number: number, over: Record<string, unknown> = {}) => ({
  repo: REPO,
  number,
  url: `https://example.com/${REPO}/issues/${number}`,
  pageUrl: `/issues.html?issue=github/${REPO}/${number}`,
  tracked: true,
  ...over,
});

const none = { passed: 0, running: 0, waiting: 0, failed: 0 };
const mentioning = (number: number) => ({
  forge: 'github',
  repo: REPO,
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  ci: 'success',
  checks: { ...none, passed: 3 },
  awaitingWorkflowApproval: false,
});

const pullRequest = (number: number, mentionsIssues: unknown[]) => ({
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
  closesIssues: [],
  mentionsIssues,
});

const issue = (number: number, mentionedByPullRequests: unknown[]) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'ryankes',
  labels: [{ name: 'enhancement' }],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests: [],
  mentionedByPullRequests,
});

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const details = {
  description: {
    text: 'The text.',
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
  state: 'open',
};

async function mockBoard(
  page: Page,
  board: { pullRequests?: unknown[]; issues?: unknown[] },
) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
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
    await page.route(`**/api/v1/${endpoint}/details*`, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(details),
      }),
    );
}

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const openPullRequest = (page: Page) =>
  page
    .getByRole('button', { name: /Pull request 1/ })
    .first()
    .click();
const openIssue = (page: Page) =>
  page.locator('#issue-rows .row').first().locator('button.title').click();

test.describe('the pull request dialog', () => {
  test('lists a tracked ticket as a pill that opens it', async ({ page }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [mention(20)])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);

    const pill = prDialog(page).locator('.mention-pill');
    await expect(pill).toHaveCount(1);
    await expect(pill).toHaveText('Mentions #20');
    await expect(pill).toHaveAccessibleName('Mentions #20, opens the issue');
    await expect(pill).toHaveAttribute('href', mention(20).pageUrl);
  });

  test('links a ticket the dashboard does not track straight to the forge', async ({
    page,
  }) => {
    const other = mention(4, {
      repo: 'alrayyes/other',
      url: 'https://example.com/alrayyes/other/issues/4',
      tracked: false,
    });
    await mockBoard(page, { pullRequests: [pullRequest(1, [other])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);

    const pill = prDialog(page).locator('.mention-pill');
    await expect(pill).toHaveText('Mentions alrayyes/other#4');
    await expect(pill).toHaveAccessibleName(
      'Mentions alrayyes/other#4, opens on the forge',
    );
    await expect(pill).toHaveAttribute('href', other.url);
    await expect(pill).toHaveAttribute('target', '_blank');
    await expect(pill).toHaveAttribute('rel', /noopener/);
  });

  test('folds mentions past the second behind a count that opens them', async ({
    page,
  }) => {
    await mockBoard(page, {
      pullRequests: [
        pullRequest(
          1,
          [20, 21, 22, 23].map((n) => mention(n)),
        ),
      ],
    });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);

    const pills = prDialog(page).locator('.mention-pill');
    await expect(pills).toHaveCount(2);
    const more = prDialog(page).getByRole('button', {
      name: '2 more issues that this pull request mentions',
    });
    await expect(more).toHaveText('2 more');
    await more.click();
    await expect(pills).toHaveCount(4);
    await expect(pills.nth(2)).toBeFocused();
  });

  test('shows nothing when no ticket is mentioned', async ({ page }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);

    await expect(prDialog(page)).toBeVisible();
    await expect(prDialog(page).locator('.mention-pill')).toHaveCount(0);
    await expect(prDialog(page).getByText(/Mentions/)).toHaveCount(0);
  });
});

test.describe('the issue dialog', () => {
  test('lists a pull request that mentions the issue, under a label', async ({
    page,
  }) => {
    await mockBoard(page, { issues: [issue(1, [mentioning(7)])] });
    await page.goto('/issues.html');
    await openIssue(page);

    const pill = issueDialog(page).locator('.mention-pill');
    await expect(pill).toHaveCount(1);
    await expect(pill).toHaveAccessibleName(
      /^Pull request #7.*mentions this issue$/,
    );
    await expect(pill).toHaveAttribute('href', mentioning(7).pageUrl);
    await expect(issueDialog(page).getByText('Mentioned in')).toBeVisible();
  });

  test('has no label or pill when no pull request mentions it', async ({
    page,
  }) => {
    await mockBoard(page, { issues: [issue(1, [])] });
    await page.goto('/issues.html');
    await openIssue(page);

    await expect(issueDialog(page)).toBeVisible();
    await expect(issueDialog(page).locator('.mention-pill')).toHaveCount(0);
    await expect(issueDialog(page).getByText('Mentioned in')).toHaveCount(0);
  });
});

test('both dialogs have no accessibility violations in light, dark and at 390 px', async ({
  page,
}) => {
  await mockBoard(page, {
    pullRequests: [
      pullRequest(1, [
        mention(20),
        mention(4, { repo: 'alrayyes/other', tracked: false }),
      ]),
    ],
    issues: [issue(1, [mentioning(7), mentioning(8)])],
  });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [path, open, dialog] of [
        ['/pull-requests.html', openPullRequest, prDialog],
        ['/issues.html', openIssue, issueDialog],
      ] as const) {
        await page.goto(path);
        await open(page);
        await expect(
          dialog(page).locator('.mention-pill').first(),
        ).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations, `${path} ${scheme} at ${width}px`).toEqual(
          [],
        );
      }
    }
  }
});
