import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// An issue that an open pull request will close shows a pill linking to it,
// and the link opens that pull request's pop-up on its page. Mocks
// /api/dashboard and the details endpoints only and writes no per-user state,
// so it starts from the shared session.
// https://github.com/alrayyes/forge-dashboard/issues/2082
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const REPO = 'alrayyes/forge-dashboard';
const address = (number: number, page = 'pull-requests') =>
  `/${page}.html?pr=github/${REPO}/${number}`;

const linked = (number: number, draft = false, repo = REPO) => ({
  forge: 'github',
  repo,
  number,
  draft,
  pageUrl: `/pull-requests.html?pr=github/${repo}/${number}`,
});

const issue = (number: number, linkedPullRequests: unknown[]) => ({
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
});

const pullRequest = (
  number: number,
  overrides: Record<string, unknown> = {},
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
  ...overrides,
});

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const details = {
  description: {
    text: 'Closes the **issue**.',
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

type Board = { shown: unknown[]; everything?: unknown[]; issues?: unknown[] };

// What the page asks for with drafts and hidden pull requests included gets
// the longer list, as the real endpoint would answer.
async function mockBoard(page: Page, board: Board) {
  const asked: string[] = [];
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) => {
    const url = route.request().url();
    asked.push(url);
    const all = url.includes('includeHidden=true');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: all ? (board.everything ?? board.shown) : board.shown,
        issues: board.issues ?? [],
      }),
    });
  });
  await page.route('**/api/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(details),
    }),
  );
  return asked;
}

const pills = (page: Page, number: number) =>
  page
    .locator('#issue-rows .row', { hasText: `Issue ${number}` })
    .locator('.linked-pr');
const dialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });

test.describe('the pill on an issue row', () => {
  test('shows the pull request number and state, and says what it is to a screen reader', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [],
      issues: [
        issue(1, [linked(12)]),
        issue(2, []),
        issue(3, [linked(13, true)]),
      ],
    });
    await page.goto('/issues.html');

    await expect(pills(page, 1)).toHaveCount(1);
    await expect(pills(page, 1)).toHaveText('#12 open');
    await expect(pills(page, 1)).toHaveAccessibleName(
      'Pull request #12 open, closes this issue',
    );
    await expect(pills(page, 1)).toHaveAttribute('href', address(12));
    await expect(pills(page, 3)).toHaveText('#13 draft');
    await expect(pills(page, 2)).toHaveCount(0);
  });

  test('names the repository when the pull request is in another one', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [],
      issues: [issue(1, [linked(4, false, 'alrayyes/other')])],
    });
    await page.goto('/issues.html');

    await expect(pills(page, 1)).toHaveText('alrayyes/other#4 open');
    await expect(pills(page, 1)).toHaveAccessibleName(
      'Pull request alrayyes/other#4 open, closes this issue',
    );
  });

  test('shows two of several and a count that opens the rest', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mockBoard(page, {
      shown: [],
      issues: [issue(1, [linked(10), linked(11), linked(12), linked(13)])],
    });
    await page.goto('/issues.html');

    await expect(pills(page, 1)).toHaveCount(2);
    const more = page.getByRole('button', { name: /^2 more/ });
    await expect(more).toHaveText('2 more');
    await expect(more).toHaveAccessibleName(
      '2 more pull requests that will close this issue',
    );
    // Opening the rest adds no more than a line to the row.
    const row = page.locator('#issue-rows .row').first();
    const height = async () => (await row.boundingBox())?.height ?? 0;
    const before = await height();

    await more.click();

    await expect(pills(page, 1)).toHaveCount(4);
    await expect(more).toHaveCount(0);
    await expect(pills(page, 1).nth(2)).toBeFocused();
    expect(await height()).toBeLessThanOrEqual(before + 40);
  });

  test('is not a link on a dashboard someone shared, where it would open your own', async ({
    page,
  }) => {
    await mockBoard(page, { shown: [], issues: [issue(1, [linked(12)])] });
    // Alice's board has her own issue, with the same pull request closing it.
    await page.route('**/api/dashboard?owner=alice*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues: [{ ...issue(1, [linked(12)]), title: 'Alice’s issue' }],
        }),
      }),
    );
    await page.route('**/api/sharing', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sharedWithMe: [{ username: 'alice', displayName: 'Alice' }],
        }),
      }),
    );
    await page.goto('/issues.html');
    await expect(page.locator('a.linked-pr')).toHaveCount(1);

    await page
      .locator('#dashboard-owner-select')
      .selectOption({ label: 'Alice’s dashboard' });

    await expect(page.locator('.linked-pr')).toHaveText('#12 open');
    await expect(page.locator('a.linked-pr')).toHaveCount(0);
  });

  test('has no accessibility violations in light, dark and at 390 px', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [],
      issues: [issue(1, [linked(10), linked(11, true), linked(12)])],
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/issues.html');
        await expect(pills(page, 1).first()).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations, `${scheme} at ${width}px`).toEqual([]);
      }
    }
  });
});

test.describe('the address of a pull request', () => {
  test('clicking the pill loads the page with that pull request open, and closing it stays on the page', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(12), pullRequest(13)],
      issues: [issue(1, [linked(12)])],
    });
    await page.goto('/issues.html');

    await pills(page, 1).click();

    await expect(page).toHaveURL(/\/pull-requests\.html/);
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAccessibleName(
      `Pull request details: ${REPO} #12`,
    );
    // The address is clean, so a reload does not open it again.
    expect(new URL(page.url()).search).toBe('');

    await page.keyboard.press('Escape');

    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/pull-requests\.html$/);
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);
  });

  test('opening the address directly does the same', async ({ page }) => {
    await mockBoard(page, { shown: [pullRequest(12)] });

    await page.goto(address(12));

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('strong')).toHaveText('issue');
  });

  test('opens when the filter bar leaves the row out', async ({
    page,
    context,
    baseURL,
  }) => {
    // The page clears a saved author pick it does not offer, so the board
    // has to offer "someone-else": through a second pull request they wrote.
    await mockBoard(page, {
      shown: [pullRequest(12), pullRequest(13, { author: 'someone-else' })],
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
        url: baseURL ?? 'http://localhost:8080',
      },
    ]);

    await page.goto(address(12));

    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    await expect(
      page.locator('#pr-rows .row', { hasText: 'Pull request 12' }),
    ).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    await context.clearCookies({ name: 'forge-board-filters' });
  });

  test('opens a draft while drafts are hidden, read only', async ({ page }) => {
    const draft = pullRequest(14, { draft: true });
    const asked = await mockBoard(page, {
      shown: [pullRequest(12)],
      everything: [pullRequest(12), draft],
    });

    await page.goto(address(14));

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAccessibleName(
      `Pull request details: ${REPO} #14`,
    );
    await expect(
      dialog(page).getByRole('button', { name: /^(Merge|Close pull request)/ }),
    ).toHaveCount(0);
    expect(asked.some((u) => u.includes('includeHidden=true'))).toBe(true);
  });

  test("closing the pop-up opened from the address puts focus on that pull request's title", async ({
    page,
  }) => {
    await mockBoard(page, { shown: [pullRequest(12), pullRequest(13)] });

    await page.goto(address(13));
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(dialog(page)).toBeHidden();
    await expect(
      page.getByRole('button', { name: '#13 Pull request 13' }),
    ).toBeFocused();
  });

  test('closing a read only pop-up opened from the address puts focus on the title filter, not the page', async ({
    page,
  }) => {
    const draft = pullRequest(14, { draft: true });
    await mockBoard(page, {
      shown: [pullRequest(12)],
      everything: [pullRequest(12), draft],
    });

    await page.goto(address(14));
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(dialog(page)).toBeHidden();
    await expect(page.getByLabel('Filter by title')).toBeFocused();
  });

  test('a pop-up opened from a row still returns focus to that row', async ({
    page,
  }) => {
    await mockBoard(page, { shown: [pullRequest(12), pullRequest(13)] });
    await page.goto('/pull-requests.html');

    const title = page.getByRole('button', { name: '#13 Pull request 13' });
    await title.click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(title).toBeFocused();
  });

  test('says so, and keeps the address, when the lookup fails', async ({
    page,
  }) => {
    await mockBoard(page, { shown: [pullRequest(12)] });
    await page.route('**/api/dashboard?includeDrafts=true*', (route) =>
      route.fulfill({ status: 500, body: '{}' }),
    );

    await page.goto(address(99));

    await expect(
      page.getByRole('status').filter({ hasText: '#99' }),
    ).toContainText('Could not look up pull request');
    expect(new URL(page.url()).search).toBe(`?pr=github/${REPO}/99`);
  });

  test('says plainly when the pull request is not open any more', async ({
    page,
  }) => {
    await mockBoard(page, { shown: [pullRequest(12)] });

    await page.goto(address(99));

    await expect(dialog(page)).toBeHidden();
    await expect(
      page.getByRole('status').filter({ hasText: '#99' }),
    ).toHaveText(
      `Pull request ${REPO} #99 is not open any more, or this dashboard does not track it.`,
    );
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
  });

  test('a release pull request opens on the releases page', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [
        pullRequest(20, {
          kind: 'release',
          title: 'chore(main): release 1.2.3',
        }),
      ],
    });

    await page.goto(address(20, 'releases'));

    await expect(dialog(page)).toBeVisible();
  });

  test('a malformed address opens nothing', async ({ page }) => {
    await mockBoard(page, { shown: [pullRequest(12)] });

    await page.goto('/pull-requests.html?pr=github/nonsense');

    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    await expect(dialog(page)).toBeHidden();
  });
});
