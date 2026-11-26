import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// Every cell of a pull request row sits on the row's vertical middle: the
// status pill, the comments pill, the author, the dates and the action area
// (the waiting chip, Merge, Cancel auto-merge, Update branch). A row waiting
// on CI had its chip lower than the pills, so it read as two lines (#4945).
// https://github.com/alrayyes/forge-dashboard/issues/4945

const TOLERANCE = 1;
const COMMENTS = { reviewComments: 4, unresolvedThreads: 1 };
const LABELS = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'needs-review', color: 'fbca04' },
];
const WAITING = {
  state: 'waiting',
  code: 'checks_pending',
  message: 'Auto-merge is waiting for the checks to finish.',
};

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'example-org/api-gateway',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'demo-user',
    draft: false,
    ci: 'success',
    checks: { passed: 13, running: 0, waiting: 0, failed: 0 },
    labels: [],
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    allowedActions: [{ action: 'merge', primary: true }, { action: 'close' }],
    ...overrides,
  };
}

const RUNNING = {
  ci: 'pending',
  checks: { passed: 4, running: 2, waiting: 0, failed: 0 },
};

const ROWS = [
  pr(1, { title: 'Merge', ...COMMENTS }),
  pr(2, {
    title: 'Waiting chip',
    ...COMMENTS,
    ...RUNNING,
    autoMergeEnabled: true,
    autoMerge: WAITING,
  }),
  pr(3, {
    title: 'Armed chip with Cancel',
    ...COMMENTS,
    ...RUNNING,
    autoMergeEnabled: true,
    autoMerge: WAITING,
  }),
  pr(4, {
    title: 'Update branch beside Merge',
    ...COMMENTS,
    behind: true,
    allowedActions: [
      { action: 'merge', primary: true },
      { action: 'update_branch' },
      { action: 'close' },
    ],
  }),
  pr(5, {
    title: 'Labels under the title',
    ...COMMENTS,
    labels: LABELS,
    ...RUNNING,
    autoMergeEnabled: true,
    autoMerge: WAITING,
  }),
  pr(6, { title: 'Labels with Merge', ...COMMENTS, labels: LABELS }),
];

async function open(page: Page, width: number, prs = ROWS) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: prs,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(prs.length);
}

interface Measure {
  title: string;
  height: number;
  centres: Record<string, number>;
}

async function measure(page: Page): Promise<Measure[]> {
  return page.locator('#pr-rows > .row').evaluateAll((rows) =>
    rows.map((r) => {
      const centres: Record<string, number> = {};
      for (const s of [
        '.ci-pill',
        '.review-pill',
        '.author',
        '.created',
        '.updated',
        '.wait-chip',
        '.row-action-bar',
      ]) {
        const e = r.querySelector(s);
        const b = e?.getBoundingClientRect();
        if (b && b.height > 0) centres[s] = b.top + b.height / 2;
      }
      return {
        title: r.querySelector('.title-text')?.textContent ?? '',
        height: r.getBoundingClientRect().height,
        centres,
      };
    }),
  );
}

for (const width of [1280, 390]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, width);
    });

    test('the pills and the action area share one vertical centre', async ({
      page,
    }) => {
      // A phone card stacks the action under a divider and keeps its own
      // tiers, so only its pills share a line.
      const phone = width < 600;
      await expect
        .poll(async () =>
          (await measure(page)).flatMap((m) => {
            const pill = m.centres['.ci-pill'];
            return Object.entries(m.centres)
              .filter(([n]) => !phone || ['.review-pill'].includes(n))
              .filter(
                ([n, c]) => n !== '.ci-pill' && Math.abs(c - pill) > TOLERANCE,
              )
              .map(([n, c]) => `${m.title}: ${n} ${c} vs status pill ${pill}`);
          }),
        )
        .toEqual([]);
    });

    test('the row is as tall with the chip as with Merge', async ({ page }) => {
      test.skip(width < 600, 'a phone card has its own tiers');
      await expect
        .poll(async () => {
          const m = await measure(page);
          const h = (t: string) => m.find((x) => x.title.endsWith(t))!.height;
          return [
            Math.abs(h('Waiting chip') - h('Merge')),
            Math.abs(h('Labels under the title') - h('Labels with Merge')),
          ].every((d) => d <= TOLERANCE);
        })
        .toBe(true);
    });

    test('the rows have no axe violations', async ({ page }) => {
      const results = await new AxeBuilder({ page })
        .include('#pr-rows')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });
}
