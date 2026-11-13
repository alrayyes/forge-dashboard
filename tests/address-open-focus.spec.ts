import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A pull request opened from its address while the other filters leave one
// row: its row is filtered out and the title box is hidden (#3823), so closing
// the dialog must put focus on a control that is drawn (#3844). Mocks
// /api/v1/dashboard and the details endpoint only and writes no saved state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const REPO = 'alrayyes/forge-dashboard';
const address = (number: number) =>
  `/pull-requests.html?pr=github/${REPO}/${number}`;

const pullRequest = (number: number, author = 'ryankes') => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Pull request ${number}`,
  url: `https://example.com/pull/${number}`,
  author,
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(5),
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
  closesIssues: [],
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

async function mockBoard(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pullRequest(12), pullRequest(13, 'someone-else')],
        issues: [],
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(details),
    }),
  );
}

// The cookie's pick leaves pull request 13 alone, so 12's row is out and the
// title box is hidden.
async function filterToOneRow(page: Page, baseURL: string | undefined) {
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

const dialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });

// The id the dialog was given to fall back to must name a control that is
// drawn. The dialog's own generic selector would hide a hidden id (#3844).
async function expectFallbackDrawn(page: Page) {
  const id = await dialog(page).getAttribute('data-return-focus-fallback');
  expect(id, 'the dialog names a fallback').toBeTruthy();
  await expect(page.locator(`#${id}`)).toBeVisible();
}

test.describe('closing a pull request opened from its address onto a hidden title box', () => {
  test.afterEach(async ({ context }) => {
    await context.clearCookies({ name: 'forge-board-filters' });
  });

  test('puts focus on a drawn control in the filter bar, not the page', async ({
    page,
    baseURL,
  }) => {
    await mockBoard(page);
    await filterToOneRow(page, baseURL);

    await page.goto(address(12));
    await expect(dialog(page)).toBeVisible();
    await expect(
      page.locator('#pr-rows .row', { hasText: 'Pull request 12' }),
    ).toHaveCount(0);
    await expectFallbackDrawn(page);
    await page.keyboard.press('Escape');

    await expect(dialog(page)).toBeHidden();
    await expect(page.getByLabel('Filter by title')).toBeHidden();
    // The pull requests bar has no pills at one row, so the sort box is the
    // first control drawn.
    await expect(page.getByLabel('Sort pull requests by')).toBeFocused();
  });

  test('puts focus on the Filters button on a phone', async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockBoard(page);
    await filterToOneRow(page, baseURL);

    await page.goto(address(12));
    await expect(dialog(page)).toBeVisible();
    await expectFallbackDrawn(page);
    await page.keyboard.press('Escape');

    await expect(dialog(page)).toBeHidden();
    await expect(page.getByLabel('Filter by title')).toBeHidden();
    await expect(page.locator('#filters-button')).toBeFocused();
  });
});
