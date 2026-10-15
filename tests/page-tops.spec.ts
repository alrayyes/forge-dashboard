import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { navCountsFor } from './nav-counts-helper';
import { registerViaInvite } from './register-helper';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// Each number appears once (#1325): the nav icons carry the totals and the
// failed counts (#1315), so the pages start with the list instead of a row of
// tiles that repeat them. What the tiles alone showed moves: the filtered
// count is one line, and the repo count lives on Insights.
// https://github.com/alrayyes/forge-dashboard/issues/1325

// Only the pill and filter tests below save filter state, so they keep a
// user of their own.
async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `page-tops-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Page Tops');
}

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    allowedActions: [{ action: 'merge' }, { action: 'close' }],
    ...overrides,
  };
}

const ISSUE = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 7,
  title: 'An issue',
  url: 'https://example.com/issues/7',
  author: 'ryan',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function serve(
  page: Page,
  pullRequests: unknown[],
  issues: unknown[] = [],
  repoCounts: Record<string, number> = { github: 1 },
) {
  const answer = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: Object.entries(repoCounts).map(([forge, repoCount]) => ({
          forge,
          reachable: true,
          repoCount,
        })),
        pullRequests,
        issues,
        openIssueCount: issues.length,
        navCounts: navCountsFor(pullRequests, issues.length),
      }),
    });
  await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/dashboard*', answer);
  await page.route('**/api/dashboard/refresh*', answer);
}

const TILES = [
  '.stats',
  '#stat-prs',
  '#stat-failing-tile',
  '#stat-failing',
  '#stat-issues',
  '#stat-repos',
];

const PAGES = [
  { path: '/pull-requests.html' },
  { path: '/releases.html' },
  { path: '/bots.html' },
  { path: '/issues.html' },
] as const;

test.describe('the pages start with the list (#1325)', () => {
  // Reads mocked data only, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  for (const { path } of PAGES) {
    test(`${path} has no stat tiles`, async ({ page }) => {
      await serve(
        page,
        [
          makePR(1),
          makePR(2, { kind: 'release' }),
          makePR(3, { kind: 'dependency' }),
        ],
        [ISSUE],
      );
      await page.goto(path);
      await expect(page.locator('.filter-bar')).toBeVisible();

      for (const selector of TILES)
        await expect(page.locator(selector)).toHaveCount(0);
    });
  }
});

test.describe('the banners sit above the filter bar (#1325)', () => {
  // Reads mocked data only, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  // The stat tiles used to be the anchor the banners were inserted before.
  test('the unreachable-forge banner comes before the filter bar', async ({
    page,
  }) => {
    const answer = (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            {
              forge: 'github',
              reachable: false,
              repoCount: 1,
              errorKind: 'unreachable',
              staleSince: new Date(Date.now() - 5 * 60_000).toISOString(),
            },
          ],
          pullRequests: [makePR(1)],
          issues: [],
          navCounts: navCountsFor([makePR(1)], 0),
        }),
      });
    await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
    await page.route('**/api/dashboard*', answer);
    await page.route('**/api/dashboard/refresh*', answer);
    await page.goto('/pull-requests.html');
    await expect(page.locator('#unreachable-banner')).toBeVisible();

    const before = await page.evaluate(() => {
      const banner = document.querySelector('#unreachable-banner');
      const bar = document.querySelector('.filter-bar');
      if (!banner || !bar) return null;
      return Boolean(
        banner.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });

    expect(before).toBe(true);
  });
});

test.describe('one line says how many are shown (#1325)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('unfiltered it gives the total', async ({ page }) => {
    await serve(page, [makePR(1), makePR(2)]);
    await page.goto('/pull-requests.html');

    await expect(page.locator('#pr-count')).toHaveText('2 open');
  });

  test('a filter that hides rows says "Showing 1 of 2"', async ({ page }) => {
    await serve(page, [makePR(1), makePR(2, { ci: 'failure' })]);
    await page.goto('/pull-requests.html');
    await page.locator('.quick-pills .quick-pill[data-pill="failing"]').click();

    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    await expect(page.locator('#pr-count')).toHaveText('Showing 1 of 2');
  });

  test('the Failing pill filters to failing pull requests, and All clears it', async ({
    page,
  }) => {
    await serve(page, [makePR(1), makePR(2, { ci: 'failure' })]);
    await page.goto('/pull-requests.html');
    const pill = page.locator('.quick-pills .quick-pill[data-pill="failing"]');

    await pill.click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    await expect(page.locator('#pr-rows')).toContainText('Pull request 2');

    await page.locator('.quick-pills .quick-pill[data-pill="all"]').click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
  });

  test('issues say it the same way', async ({ page }) => {
    await serve(
      page,
      [],
      [ISSUE, { ...ISSUE, number: 8, title: 'Another issue' }],
    );
    await page.goto('/issues.html');
    await page.locator('input[data-col="title"]').fill('Another');

    await expect(page.locator('#issue-count')).toHaveText('Showing 1 of 2');
  });
});

test.describe('an empty page says so (#1325)', () => {
  // Reads mocked data only, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('the pull request page with none open says nothing is open', async ({
    page,
  }) => {
    await serve(page, []);
    await page.goto('/pull-requests.html');

    await expect(page.locator('#pr-empty')).toHaveText(
      'No open pull requests.',
    );
  });

  test('Releases, Bots and Issues, hidden from the nav at zero, still say it when typed in', async ({
    page,
  }) => {
    await serve(page, []);

    await page.goto('/releases.html');
    await expect(page.locator('#pr-empty')).toContainText(
      'No release pull requests are open.',
    );
    await page.goto('/bots.html');
    await expect(page.locator('#pr-empty')).toContainText(
      'No bot pull requests are open.',
    );
    await page.goto('/issues.html');
    await expect(page.locator('#issue-empty')).toHaveText('No open issues.');
  });
});

test.describe('the Branches page drops its summary line (#1325)', () => {
  // Reads mocked data only, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('no "N tracked: …" line, and the pills keep their counts', async ({
    page,
  }) => {
    const row = (name: string, status: string) => ({
      forge: 'github',
      fullName: name,
      url: `https://example.com/${name}`,
      branch: 'main',
      status,
      commit: null,
      failingJobs: [],
      finishedAt: null,
      durationSeconds: null,
      runUrl: '',
      stale: false,
      staleSince: null,
    });
    const branches = [row('a/one', 'failed'), row('a/two', 'passed')];
    await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
    await page.route('**/api/main-branches', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          counts: { failed: 1, running: 0, passed: 1, none: 0, total: 2 },
          branches,
        }),
      }),
    );
    await page.goto('/');

    await expect(page.locator('[data-testid="main-branch-row"]')).toHaveCount(
      2,
    );
    await expect(page.locator('#mb-summary')).toHaveCount(0);
    await expect(page.getByText(/\d+ tracked/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^All 2$/ })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Failing 1$/ }),
    ).toBeVisible();
  });
});

test.describe('the repo count lives on Insights (#1325)', () => {
  // Reads mocked data only, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('Insights says how many repositories are tracked, across forges', async ({
    page,
  }) => {
    await serve(page, [makePR(1)], [], { github: 4, forgejo: 2 });
    await page.goto('/insights.html');

    await expect(page.locator('#insights-tracked')).toHaveText(
      '6 repositories tracked',
    );
  });

  test('one repository is singular', async ({ page }) => {
    await serve(page, [makePR(1)], [], { github: 1 });
    await page.goto('/insights.html');

    await expect(page.locator('#insights-tracked')).toHaveText(
      '1 repository tracked',
    );
  });
});

test.describe('the pages without tiles are accessible (#1325)', () => {
  // Reads mocked data only, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

  for (const scheme of ['light', 'dark'] as const) {
    for (const path of [
      '/pull-requests.html',
      '/issues.html',
      '/insights.html',
    ]) {
      test(`${path} has no axe violations (${scheme})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await serve(page, [makePR(1), makePR(2, { ci: 'failure' })], [ISSUE]);
        await page.goto(path);
        await expect(page.locator('main, .wrap').first()).toBeVisible();

        expect(
          (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
        ).toEqual([]);
      });
    }
  }
});
