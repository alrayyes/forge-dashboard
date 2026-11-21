import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// Hovering or focusing a Closes, Refs, Mentions or linked pull request pill
// shows the item's title, then what the pill does (#4326). The hover is the
// native title attribute, as on a row's title; keyboard focus shows the same
// text in the pill's tip. Mocks /api/v1/dashboard and the details endpoints
// only and writes no saved state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const REPO = 'alrayyes/forge-dashboard';
const LONG =
  'Show the title of an item when the pointer rests on one of its pills, wrapped and never cut off by the edge of a narrow screen '.repeat(
    2,
  ) + 'Supercalifragilisticexpialidocious'.repeat(3);

const link = (
  number: number,
  relation: 'closes' | 'refs' | 'mentions',
  title?: string,
) => ({
  repo: REPO,
  number,
  relation,
  tracked: true,
  ...(title === undefined ? {} : { title }),
  url: `https://example.com/${REPO}/issues/${number}`,
  pageUrl: `/issues.html?issue=github/${REPO}/${number}`,
});

const pullRequest = (
  number: number,
  closesIssues: unknown[],
  refsIssues: unknown[] = [],
  mentionsIssues: unknown[] = [],
) => ({
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
  refsIssues,
  mentionsIssues,
});

const issue = (number: number, linkedPullRequests: unknown[] = []) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'ryankes',
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests,
  mentionedByPullRequests: [],
  referencedByPullRequests: [],
});

const linked = (number: number, title?: string) => ({
  forge: 'github',
  repo: REPO,
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  ci: 'success',
  checks: { passed: 1, running: 0, waiting: 0, failed: 0 },
  awaitingWorkflowApproval: false,
  ...(title === undefined ? {} : { title }),
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
  references: [],
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
        forges: [forgeHealth('github')],
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

const prRow = (page: Page, number: number) =>
  page.locator('#pr-rows .row', { hasText: `Pull request ${number}` });

// Tab onto the pill so it has keyboard focus, which is what shows its tip.
async function focusByKeyboard(page: Page, pill: ReturnType<Page['locator']>) {
  await pill.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(pill).toBeFocused();
}

test.describe('a pill on a pull request row names what it points at', () => {
  test('hover text is the title, then what the pill does', async ({ page }) => {
    await mockBoard(page, {
      pullRequests: [
        pullRequest(
          1,
          [link(10, 'closes', 'Show titles')],
          [link(12, 'refs', 'Tidy the band')],
        ),
      ],
    });
    await page.goto('/pull-requests.html');

    await expect(prRow(page, 1).locator('.closing-issue')).toHaveAttribute(
      'title',
      'Show titles\nCloses the issue when it merges',
    );
    await expect(prRow(page, 1).locator('.refs-issue')).toHaveAttribute(
      'title',
      'Tidy the band\nReferences the issue, does not close it',
    );
  });

  test("a pill with no known title keeps today's text, with no empty line and no tip", async ({
    page,
  }) => {
    await mockBoard(page, {
      pullRequests: [
        pullRequest(1, [link(10, 'closes'), link(11, 'closes', '  ')]),
      ],
    });
    await page.goto('/pull-requests.html');

    const pills = prRow(page, 1).locator('.closing-issue');
    await expect(pills).toHaveCount(2);
    for (const pill of await pills.all()) {
      await expect(pill).toHaveAttribute(
        'title',
        'Closes the issue when it merges',
      );
    }
    await expect(prRow(page, 1).locator('[role="tooltip"]')).toHaveCount(0);
    await expect(prRow(page, 1)).not.toContainText('undefined');
  });

  test('keyboard focus shows the same text, the name still starts with the visible text, and Escape hides it with focus kept', async ({
    page,
  }) => {
    await mockBoard(page, {
      pullRequests: [pullRequest(1, [link(10, 'closes', 'Show titles')])],
    });
    await page.goto('/pull-requests.html');

    const pill = prRow(page, 1).locator('.closing-issue');
    const tip = prRow(page, 1).locator('[role="tooltip"]');
    await expect(tip).toBeHidden();
    await focusByKeyboard(page, pill);
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText(
      'Show titles\nCloses the issue when it merges',
    );
    await expect(pill).toHaveAccessibleName(/^Closes #10/);
    await expect(pill).toHaveAccessibleDescription(
      /^Show titles\s+Closes the issue when it merges$/,
    );

    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();
    await expect(pill).toBeFocused();
  });

  test('a title is text, never markup', async ({ page }) => {
    const markup = '<img src=x onerror="window.pwned=1"><b>bold</b>';
    await mockBoard(page, {
      pullRequests: [pullRequest(1, [link(10, 'closes', markup)])],
    });
    await page.goto('/pull-requests.html');

    const pill = prRow(page, 1).locator('.closing-issue');
    await focusByKeyboard(page, pill);
    const tip = prRow(page, 1).locator('[role="tooltip"]');
    await expect(tip).toContainText(markup);
    await expect(tip.locator('*')).toHaveCount(0);
    expect(await page.evaluate(() => 'pwned' in window)).toBe(false);
  });

  test('a mention names its target too', async ({ page }) => {
    await mockBoard(page, {
      pullRequests: [
        pullRequest(1, [], [], [link(9, 'mentions', 'Earlier idea')]),
      ],
    });
    await page.goto('/pull-requests.html');
    await prRow(page, 1)
      .getByRole('button', { name: /Pull request 1/ })
      .first()
      .click();

    const popup = page.getByRole('dialog', { name: /^Pull request details/ });
    await expect(popup.locator('.mention-pill')).toHaveAttribute(
      'title',
      'Earlier idea\nMentioned here, does not close it',
    );
  });

  test("the Related band's pills in the pull request pop-up show it too", async ({
    page,
  }) => {
    await mockBoard(page, {
      pullRequests: [pullRequest(1, [link(10, 'closes', 'Show titles')])],
    });
    await page.goto('/pull-requests.html');
    await prRow(page, 1)
      .getByRole('button', { name: /Pull request 1/ })
      .first()
      .click();

    const popup = page.getByRole('dialog', { name: /^Pull request details/ });
    const pill = popup.locator('.closing-issue');
    await expect(pill).toHaveAttribute(
      'title',
      'Show titles\nCloses the issue when it merges',
    );
    await expect(pill).toHaveAccessibleName(/^Closes: #10/);
  });
});

test.describe('a pill on an issue row names its pull request', () => {
  test('hover and focus show the title, then the relation', async ({
    page,
  }) => {
    await mockBoard(page, {
      issues: [issue(5, [linked(20, 'Show titles')]), issue(6, [linked(21)])],
    });
    await page.goto('/issues.html');

    const named = page
      .locator('#issue-rows .row', { hasText: 'Issue 5' })
      .locator('.linked-pr');
    await expect(named).toHaveAttribute(
      'title',
      'Show titles\nCloses this issue when it merges',
    );
    await focusByKeyboard(page, named);
    const tip = page
      .locator('#issue-rows .row', { hasText: 'Issue 5' })
      .locator('[role="tooltip"]');
    await expect(tip).toHaveText(
      'Show titles\nCloses this issue when it merges',
    );
    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();
    await expect(named).toBeFocused();

    const unnamed = page
      .locator('#issue-rows .row', { hasText: 'Issue 6' })
      .locator('.linked-pr');
    await expect(unnamed).toHaveAttribute(
      'title',
      'Closes this issue when it merges',
    );
  });
});

for (const width of [1280, 390]) {
  test.describe(`a long title at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test('stays inside the viewport and wraps', async ({ page }) => {
      await mockBoard(page, {
        pullRequests: [pullRequest(1, [link(10, 'closes', LONG)])],
      });
      await page.goto('/pull-requests.html');

      const pill = prRow(page, 1).locator('.closing-issue');
      await focusByKeyboard(page, pill);
      const tip = prRow(page, 1).locator('[role="tooltip"]');
      await expect(tip).toBeVisible();
      const box = await tip.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      // Wrapped over several rows, not one long line.
      expect(box?.height ?? 0).toBeGreaterThan(40);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
    });
  });
}
