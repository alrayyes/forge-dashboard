import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { mainBranchPageOf } from './nav-counts-helper';
import { test } from './server-fixture';

// One axe sweep for every pill the dashboard draws, in both themes: the CI
// pill on the pull request board in each state it has, the pill on an issue's
// linked pull request, the pill on the Main branches page, and the counts in
// the nav. The per-feature pill specs used to scan their own copy of this
// each (#3500); they keep their behaviour tests and leave the scan here.
// https://github.com/alrayyes/forge-dashboard/issues/3500

const THEMES = ['light', 'dark'] as const;

type Size = { width: number; height: number };

const WIDE = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 800 };
// The tablet width the filter groups switch layout around (#3780).
const TABLET = { width: 820, height: 900 };
// The Cancelled pill (#3395) is checked down to the narrowest phone.
const NARROW = { width: 320, height: 800 };
// The nav pills (#1439, #1458) are checked on a 360px phone.
const NAV_PHONE = { width: 360, height: 740 };

async function expectAccessible(
  page: Page,
  sizes: Size[],
  ready: () => Promise<void>,
) {
  for (const size of sizes) {
    await page.setViewportSize(size);
    await ready();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, `${size.width}px`).toEqual([]);
    const [scroll, client] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(scroll, `${size.width}px scrolls sideways`).toBeLessThanOrEqual(
      client,
    );
  }
}

const ago = (seconds: number) =>
  new Date(Date.now() - seconds * 1000).toISOString();

async function routeDashboard(page: Page, body: object) {
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
        pullRequests: [],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
        ...body,
      }),
    }),
  );
}

// ---- pull request board ----

type Checks = {
  passed: number;
  skipped?: number;
  running: number;
  waiting: number;
  failed: number;
  cancelled?: number;
};

const checks = (c: Partial<Checks>): Checks => ({
  passed: 0,
  running: 0,
  waiting: 0,
  failed: 0,
  ...c,
});

function pr(
  number: number,
  title: string,
  ci: string,
  counts?: Checks,
  forge = 'github',
) {
  return {
    forge,
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://example.test/alrayyes/app/pull/${number}`,
    author: 'claude',
    draft: false,
    ci,
    ...(counts ? { checks: counts } : {}),
    labels: [],
    createdAt: ago(0),
    updatedAt: ago(200 - number),
    mergeStatus: 'mergeable',
  };
}

// Every state of the pill: running with counts, with none, and only waiting;
// passed and failed with and without counts (#2074); failed with the pipeline
// still going; skipped beside passed and alone (#2145); cancelled with and
// without a passed count (#3395); a Forgejo row with a long tally (#3248).
const PRS = [
  pr(
    1,
    'Running mid',
    'pending',
    checks({ passed: 5, running: 2, waiting: 3 }),
  ),
  pr(2, 'Running early', 'pending', checks({ running: 1, waiting: 8 })),
  pr(3, 'Running single', 'pending', checks({ running: 1 })),
  pr(4, 'Running plain', 'pending'),
  pr(5, 'Clean run', 'success', checks({ passed: 12 })),
  pr(
    6,
    'Mixed run',
    'failure',
    checks({ passed: 8, running: 1, waiting: 2, failed: 3 }),
  ),
  pr(7, 'Lone fail', 'failure', checks({ failed: 1 })),
  pr(8, 'Plain pass', 'success'),
  pr(9, 'Plain fail', 'failure'),
  pr(10, 'Zero fail', 'failure', checks({})),
  pr(
    11,
    'Forgejo big pipeline',
    'pending',
    checks({ passed: 28, running: 1, waiting: 2 }),
    'forgejo',
  ),
  pr(12, 'Some skipped', 'success', checks({ passed: 8, skipped: 2 })),
  pr(13, 'All skipped', 'success', checks({ passed: 3, skipped: 3 })),
  pr(
    14,
    'Skipped and failing',
    'failure',
    checks({ passed: 4, skipped: 1, running: 1, waiting: 2, failed: 3 }),
  ),
  pr(
    15,
    'Some cancelled',
    'cancelled',
    checks({ passed: 4, cancelled: 9 }),
    'forgejo',
  ),
  pr(
    16,
    'None passed cancelled',
    'cancelled',
    checks({ cancelled: 13 }),
    'forgejo',
  ),
];

test(`pull request pills in every state have no axe violations in both themes`, async ({
  page,
}) => {
  for (const scheme of THEMES) {
    await test.step(`${scheme}`, async () => {
      await page.emulateMedia({ colorScheme: scheme });

      await routeDashboard(page, {
        forges: [
          { forge: 'github', reachable: true, repoCount: 1 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests: PRS,
      });

      await page.goto('/pull-requests.html');

      await expect(page.locator('#pr-rows > .row').first()).toBeVisible();

      await expectAccessible(page, [WIDE, TABLET, PHONE, NARROW], () =>
        expect(page.locator('#pr-rows > .row .ci-pill')).toHaveCount(
          PRS.length,
        ),
      );
    });
  }
});

// ---- issues ----

const linked = (number: number, counts: Checks) => ({
  forge: 'github',
  repo: 'alrayyes/app',
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/alrayyes/app/${number}`,
  ci: 'success',
  checks: counts,
  awaitingWorkflowApproval: false,
});

const ISSUES = [
  checks({ passed: 8, skipped: 2 }),
  checks({ passed: 3, skipped: 3 }),
].map((counts, i) => ({
  forge: 'github',
  repo: 'alrayyes/app',
  number: i + 1,
  title: `Issue ${i + 1}`,
  url: `https://example.test/issues/${i + 1}`,
  author: 'ryankes',
  labels: [],
  createdAt: ago(3600),
  updatedAt: ago(300),
  linkedPullRequests: [linked(12 + i, counts)],
}));

test(`issue pills have no axe violations in both themes`, async ({ page }) => {
  for (const scheme of THEMES) {
    await test.step(`${scheme}`, async () => {
      await page.emulateMedia({ colorScheme: scheme });

      await routeDashboard(page, { issues: ISSUES, openIssueCount: 2 });

      await page.goto('/issues.html');

      await expectAccessible(page, [WIDE, PHONE], () =>
        expect(page.locator('#issue-rows .row .linked-pr')).toHaveCount(
          ISSUES.length,
        ),
      );
    });
  }
});

// ---- Main branches ----

type Status = 'failed' | 'running' | 'passed' | 'cancelled' | 'none';

function branch(fullName: string, status: Status, counts?: Checks) {
  return {
    forge: 'github',
    fullName,
    url: `https://example.test/${fullName}`,
    branch: 'main',
    status,
    commit: {
      sha: 'd98f3c2',
      subject: `fix: change in ${fullName}`,
      author: 'sre-dev',
      committedAt: ago(1800),
    },
    failingJobs: status === 'failed' ? ['lint'] : [],
    finishedAt: null,
    durationSeconds: null,
    runUrl: `https://example.test/${fullName}/actions/runs/1`,
    ...(counts ? { checks: counts } : {}),
    staleSince: null,
  };
}

const BRANCHES = [
  branch(
    'acme/red',
    'failed',
    checks({ passed: 8, running: 1, waiting: 2, failed: 3 }),
  ),
  branch(
    'acme/going',
    'running',
    checks({ passed: 5, running: 2, waiting: 3 }),
  ),
  branch('acme/green', 'passed', checks({ passed: 12 })),
  branch('acme/plain', 'passed', checks({})),
  branch('acme/older', 'failed'),
  branch('acme/stopped', 'cancelled', checks({ passed: 2 })),
  branch('acme/some-skipped', 'passed', checks({ passed: 8, skipped: 2 })),
  branch('acme/all-skipped', 'passed', checks({ passed: 3, skipped: 3 })),
  branch(
    'acme/red-skipped',
    'failed',
    checks({ passed: 4, skipped: 1, failed: 2 }),
  ),
  branch('acme/new', 'none', checks({})),
];

test(`Main branches pills have no axe violations in both themes`, async ({
  page,
}) => {
  for (const scheme of THEMES) {
    await test.step(`${scheme}`, async () => {
      await page.emulateMedia({ colorScheme: scheme });

      await routeDashboard(page, {});

      await page.route('**/api/v1/main-branches', (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            counts: {
              failed: 3,
              passed: 4,
              running: 1,
              cancelled: 1,
              awaitingApproval: 0,
              none: 1,
              total: BRANCHES.length,
            },
            branches: BRANCHES,
          }),
        }),
      );

      await page.goto('/');

      await expectAccessible(page, [WIDE, PHONE], () =>
        expect(page.locator('[data-testid="main-branch-row"]')).toHaveCount(
          BRANCHES.length,
        ),
      );
    });
  }
});

// ---- nav ----

const nav = (
  total: number,
  running: number,
  failed: number,
  passed: number,
  noChecks = 0,
) => ({
  total,
  running,
  failed,
  passed,
  noChecks,
});

test(`nav pills have no axe violations in both themes`, async ({ page }) => {
  for (const scheme of THEMES) {
    await test.step(`${scheme}`, async () => {
      await page.emulateMedia({ colorScheme: scheme });

      await routeDashboard(page, {
        openIssueCount: 4,
        navCounts: {
          pullRequests: nav(15, 3, 2, 10),
          issues: { total: 4 },
          releases: nav(6, 6, 0, 0),
          bots: nav(16, 3, 2, 10, 1),
        },
        mainBranchPage: mainBranchPageOf([
          'failed',
          'failed',
          'running',
          'passed',
          'passed',
          'passed',
          'none',
          'awaiting_approval',
        ]),
      });

      await page.goto('/settings.html');

      await expectAccessible(page, [WIDE, NAV_PHONE], async () => {
        await expect(
          page.locator('header nav a[href="/pull-requests.html"] .nav-pills'),
        ).toHaveCount(1);
        await expect(
          page.locator('header nav a[href="/"] .nav-pills'),
        ).toHaveCount(1);
      });
    });
  }
});
