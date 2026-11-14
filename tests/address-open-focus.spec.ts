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
    // The sort and group boxes are disabled over one row (#3886) and cannot
    // take focus, so it lands on the first enabled control still drawn.
    await expect(page.getByLabel('Sort pull requests by')).toBeDisabled();
    await expect(page.locator('#created-filter')).toBeFocused();
  });

  test('with a sort and a grouping chosen, focus still lands on an enabled control', async ({
    page,
    baseURL,
  }) => {
    await mockBoard(page);
    await page.goto('/pull-requests.html');
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);
    await page.getByLabel('Sort pull requests by').selectOption('created');
    await page.getByLabel('Group rows by').selectOption('repo');
    // Carry the chosen sort and grouping into a load that the author pick
    // narrows to one row.
    const saved = (await page.context().cookies()).find(
      (c) => c.name === 'forge-board-filters',
    );
    const state = saved
      ? JSON.parse(decodeURIComponent(saved.value))
      : { rev: 2_000_000_000 };
    state.shared = { ...state.shared, author: 'github:someone-else' };
    await page.context().addCookies([
      {
        name: 'forge-board-filters',
        value: encodeURIComponent(JSON.stringify(state)),
        url: baseURL,
      },
    ]);

    await page.goto(address(12));
    await expect(dialog(page)).toBeVisible();
    await expectFallbackDrawn(page);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();

    // Sort is disabled over one row. Whatever holds focus is a drawn, enabled
    // control, never the page and never a disabled select (WCAG 2.4.3).
    await expect(page.getByLabel('Sort pull requests by')).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return (
            !!el &&
            el !== document.body &&
            !el.matches(':disabled') &&
            el.getClientRects().length > 0 &&
            !!el.closest('.filter-bar')
          );
        }),
      )
      .toBe(true);
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
