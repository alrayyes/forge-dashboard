import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// On a wide screen a title takes the row's spare width and is cut only when
// the row has none left. Before, the title column shrank to fit its labels and
// pills, so a long title was cut with a wide empty gap before the Created
// column.
// https://github.com/alrayyes/forge-dashboard/issues/2801

const LONG =
  'fix(dashboard): settle box overrides only for rows a full refresh fetched and keep the rest';

const linked = {
  forge: 'github',
  repo: 'acme/app',
  number: 9,
  draft: false,
  pageUrl: '/pull-requests.html',
  ci: 'success',
  checks: { passed: 24, running: 0, waiting: 0, failed: 0 },
  awaitingWorkflowApproval: false,
};

const ISSUES = [
  {
    forge: 'github',
    repo: 'acme/app',
    number: 2796,
    title: LONG,
    url: 'https://example.com/acme/app/issues/2796',
    author: 'alrayyes',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    linkedPullRequests: [linked],
    createdAt: new Date(Date.now() - 36 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 36 * 60_000).toISOString(),
  },
];

const PULL_REQUESTS = [
  {
    forge: 'github',
    repo: 'acme/app',
    number: 2798,
    title: LONG,
    url: 'https://example.com/acme/app/pull/2798',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
  },
];

async function open(page: Page, path: string) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: PULL_REQUESTS,
        issues: ISSUES,
        repos: [],
        hiddenDrafts: 0,
        navCounts: navCountsFor(PULL_REQUESTS, ISSUES.length),
      }),
    }),
  );
  await page.goto(path);
}

// The title column's width, the cell after it, and whether the page scrolls.
async function titleGeometry(page: Page, board: string) {
  const row = page.locator(`#${board} > .row`).first();
  await expect(row).toBeVisible();
  return row.evaluate((r) => {
    const cell = r.querySelector('.title-cell') as HTMLElement;
    const after = r.querySelector('.author') as HTMLElement;
    const go = r.querySelector('.go') as HTMLElement;
    const status = r.querySelector('.status-cell') as HTMLElement | null;
    const box = cell.getBoundingClientRect();
    const tracks = getComputedStyle(r).gridTemplateColumns.split(' ');
    return {
      isIssueRow: r.classList.contains('issue-row'),
      goRight: go.getBoundingClientRect().right,
      viewport: document.documentElement.clientWidth,
      // The status track is the one right before the arrow's.
      statusTrack: Number.parseFloat(tracks[tracks.length - 2]),
      statusWidth: status ? status.getBoundingClientRect().width : 0,
      width: box.width,
      gapToAuthor: after.getBoundingClientRect().left - box.right,
      scrollsSideways:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    };
  });
}

type Geometry = Awaited<ReturnType<typeof titleGeometry>>;

// Re-measures until every check holds, so a layout still settling on a loaded
// runner doesn't fail the test. Each check is a [what, passes] pair.
async function expectGeometry(
  page: Page,
  board: string,
  checks: (g: Geometry) => [string, boolean][],
) {
  await expect
    .poll(async () => {
      const g = await titleGeometry(page, board);
      return checks(g)
        .filter(([, ok]) => !ok)
        .map(([what]) => `${what} (${JSON.stringify(g)})`);
    })
    .toEqual([]);
}

test.describe('title width (2801)', () => {
  test('an issue title takes the status column the row does not use', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1970, height: 900 });
    await open(page, '/issues.html');
    // 268px before, with a 280px empty track after the Updated column.
    await expectGeometry(page, 'issue-rows', (g) => [
      ['issue row', g.isIssueRow],
      ['title wider than 540', g.width > 540],
      ['gap to author <= 13', g.gapToAuthor <= 13],
      ['no sideways scroll', !g.scrollsSideways],
    ]);
  });

  test('a pull request keeps its status column', async ({ page }) => {
    await page.setViewportSize({ width: 1970, height: 900 });
    await open(page, '/pull-requests.html');
    // The status cell fills a real track after the Updated column, so the
    // title shares the row with it instead of taking its width.
    await expectGeometry(page, 'pr-rows', (g) => [
      ['pull request row', !g.isIssueRow],
      ['status track > 0', g.statusTrack > 0],
      ['status fills its track', Math.abs(g.statusWidth - g.statusTrack) < 0.5],
      ['no sideways scroll', !g.scrollsSideways],
    ]);
  });

  for (const [board, path] of [
    ['issue-rows', '/issues.html'],
    ['pr-rows', '/pull-requests.html'],
  ] as const) {
    test(`a phone keeps ${board} stacked without scrolling sideways`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await open(page, path);
      await expectGeometry(page, board, (g) => [
        ['title wider than 300', g.width > 300],
        ['no sideways scroll', !g.scrollsSideways],
      ]);
    });
  }

  test('a mid-width issue row keeps its title and arrow on screen', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await open(page, '/issues.html');
    await expectGeometry(page, 'issue-rows', (g) => [
      ['title wider than 400', g.width > 400],
      ['arrow on screen', g.goRight <= g.viewport],
      ['no sideways scroll', !g.scrollsSideways],
    ]);
  });
});
