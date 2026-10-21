import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { landOnPullRequests, test } from './server-fixture';

// Every CI pill shows how many of its passed checks were skipped, with the
// pipeline dialog's word for it, on the pull request, bot, Main branches and
// Issues pages alike. Skipped sits inside passed on the wire, so the passed
// count still adds up to the checks the dialog lists; the pill draws it as a
// segment of its own, drops the passed segment when nothing really passed, and
// draws nothing for a run with none skipped. The server tallies the counts;
// the page only draws them.
// https://github.com/alrayyes/forge-dashboard/issues/2145

type Counts = {
  passed: number;
  skipped?: number;
  running: number;
  waiting: number;
  failed: number;
};

const counts = (c: Partial<Counts>): Counts => ({
  passed: 0,
  running: 0,
  waiting: 0,
  failed: 0,
  ...c,
});

function pr(number: number, title: string, ci: string, checks: Counts) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://github.com/alrayyes/app/pull/${number}`,
    author: number > 100 ? 'dependabot[bot]' : 'claude',
    draft: false,
    ci,
    checks,
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (200 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
  };
}

const PRS = [
  pr(1, 'Some skipped', 'success', counts({ passed: 8, skipped: 2 })),
  pr(2, 'All skipped', 'success', counts({ passed: 3, skipped: 3 })),
  pr(
    3,
    'Skipped and failing',
    'failure',
    counts({ passed: 4, skipped: 1, running: 1, waiting: 2, failed: 3 }),
  ),
  pr(4, 'None skipped', 'success', counts({ passed: 5, skipped: 0 })),
  pr(5, 'Older server', 'success', counts({ passed: 5 })),
  pr(101, 'Bot skipped', 'success', counts({ passed: 6, skipped: 2 })),
];

async function openBoard(page: Page, path: string) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: PRS,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(path);
  await expect(page.locator('#pr-rows > .row').first()).toBeVisible();
}

const prPill = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title }).locator('.ci-pill');
const segs = (pill: Locator) => pill.locator('.ci-seg:not(.ci-seg-label)');
const kinds = (pill: Locator) =>
  segs(pill).evaluateAll((els) =>
    els.map((e) => e.className.replace('ci-seg ', '')),
  );

test.describe('skipped counts on the pull request pill', () => {
  test('draws skipped beside passed, which stays whole', async ({ page }) => {
    await openBoard(page, '/pull-requests.html');

    const pill = prPill(page, 'Some skipped');
    await expect(segs(pill)).toHaveText(['8', '2']);
    await expect(kinds(pill)).resolves.toEqual([
      'ci-seg-passed',
      'ci-seg-skipped',
    ]);
    await expect(
      pill.locator('.ci-seg-skipped [data-glyph="slash"]'),
    ).toBeVisible();
    await expect(pill).toHaveAttribute(
      'aria-label',
      'Passed 8 2: 8 passed, 2 skipped. Open pipeline',
    );
  });

  test('a run where every pass was skipped reads as skipped alone', async ({
    page,
  }) => {
    await openBoard(page, '/pull-requests.html');

    const pill = prPill(page, 'All skipped');
    await expect(segs(pill)).toHaveText(['3']);
    await expect(kinds(pill)).resolves.toEqual(['ci-seg-skipped']);
    await expect(pill).toHaveAttribute(
      'aria-label',
      'Passed 3: 3 skipped. Open pipeline',
    );
  });

  test('sits between passed and running among the other states', async ({
    page,
  }) => {
    await openBoard(page, '/pull-requests.html');

    await expect(segs(prPill(page, 'Skipped and failing'))).toHaveText([
      '4',
      '1',
      '1',
      '2',
      '3',
    ]);
  });

  test('draws no skipped segment for none skipped, or an older server', async ({
    page,
  }) => {
    await openBoard(page, '/pull-requests.html');

    for (const title of ['None skipped', 'Older server']) {
      await expect(segs(prPill(page, title))).toHaveText(['5']);
      await expect(prPill(page, title).locator('.ci-seg-skipped')).toHaveCount(
        0,
      );
    }
  });

  test('the bot board draws it the same way', async ({ page }) => {
    await openBoard(page, '/bots.html');

    await expect(segs(prPill(page, 'Bot skipped'))).toHaveText(['6', '2']);
  });
});

const BRANCHES = [
  ['acme/some', 'passed', counts({ passed: 8, skipped: 2 })],
  ['acme/all', 'passed', counts({ passed: 3, skipped: 3 })],
  ['acme/red', 'failed', counts({ passed: 4, skipped: 1, failed: 2 })],
].map(([fullName, status, checks]) => ({
  forge: 'github',
  fullName,
  url: `https://example.com/${fullName}`,
  branch: 'main',
  status,
  commit: {
    sha: 'd98f3c2',
    subject: `fix: change in ${fullName}`,
    author: 'sre-dev',
    committedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  },
  failingJobs: status === 'failed' ? ['lint'] : [],
  finishedAt: null,
  durationSeconds: null,
  runUrl: `https://example.com/${fullName}/actions/runs/1`,
  checks,
  stale: false,
  staleSince: null,
}));

async function openBranches(page: Page) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 1,
          passed: 2,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: BRANCHES.length,
        },
        branches: BRANCHES,
      }),
    }),
  );
  await page.goto('/');
  await expect(page.locator('[data-testid="main-branch-row"]')).toHaveCount(
    BRANCHES.length,
  );
}

const branchPill = (page: Page, repo: string) =>
  page
    .locator('[data-testid="main-branch-row"]', { hasText: repo })
    .locator('.ci-pill');

test.describe('skipped counts on the Main branches pill', () => {
  test.beforeEach(async ({ page }) => {
    await landOnPullRequests(page);
  });

  test('draws the same segments as the pull request pill', async ({ page }) => {
    await openBranches(page);

    await expect(segs(branchPill(page, 'acme/some'))).toHaveText(['8', '2']);
    await expect(segs(branchPill(page, 'acme/all'))).toHaveText(['3']);
    await expect(branchPill(page, 'acme/all')).toHaveAttribute(
      'aria-label',
      'Passed 3: 3 skipped. Open pipeline',
    );
    await expect(segs(branchPill(page, 'acme/red'))).toHaveText([
      '4',
      '1',
      '2',
    ]);
  });
});

const linked = (number: number, checks: Counts) => ({
  forge: 'github',
  repo: 'alrayyes/app',
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/alrayyes/app/${number}`,
  ci: 'success',
  checks,
  awaitingWorkflowApproval: false,
});

const ISSUES = [
  { number: 1, prs: [linked(12, counts({ passed: 8, skipped: 2 }))] },
  { number: 2, prs: [linked(13, counts({ passed: 3, skipped: 3 }))] },
].map(({ number, prs }) => ({
  forge: 'github',
  repo: 'alrayyes/app',
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'ryankes',
  labels: [],
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  updatedAt: new Date(Date.now() - 300_000).toISOString(),
  linkedPullRequests: prs,
}));

async function openIssues(page: Page) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: ISSUES,
      }),
    }),
  );
  await page.goto('/issues.html');
}

const issuePill = (page: Page, number: number) =>
  page
    .locator('#issue-rows .row', { hasText: `Issue ${number}` })
    .locator('.linked-pr');

test.describe('skipped counts on the Issues page pill', () => {
  test('says them in the text and the name', async ({ page }) => {
    await openIssues(page);

    await expect(issuePill(page, 1)).toHaveText('#12 open Passed 8 2');
    await expect(issuePill(page, 1)).toHaveAccessibleName(
      'Pull request #12 open Passed 8 2: 8 passed, 2 skipped, closes this issue',
    );
    await expect(issuePill(page, 2)).toHaveText('#13 open Passed 3');
    await expect(issuePill(page, 2)).toHaveAccessibleName(
      'Pull request #13 open Passed 3: 3 skipped, closes this issue',
    );
  });
});

async function expectAccessibleAndNarrow(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scroll).toBeLessThanOrEqual(client);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test.describe(`${scheme} at ${width}px`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 800 } });

      test('pull request pills have no axe violations and no sideways scroll', async ({
        page,
      }) => {
        await openBoard(page, '/pull-requests.html');
        await expect(prPill(page, 'Skipped and failing')).toBeVisible();

        await expectAccessibleAndNarrow(page);
      });

      test('issue pills have no axe violations and no sideways scroll', async ({
        page,
      }) => {
        await openIssues(page);
        await expect(issuePill(page, 1)).toBeVisible();

        await expectAccessibleAndNarrow(page);
      });
    });
  }
}
