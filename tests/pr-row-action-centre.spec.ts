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
    allowedActions: [
      {
        action: 'merge',
        blocked: { code: 'checks_pending', message: 'Waiting' },
      },
      { action: 'cancel_auto_merge', primary: true },
      { action: 'close' },
    ],
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

async function open(
  page: Page,
  width: number,
  prs = ROWS,
  path = '/pull-requests.html',
) {
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
  await page.goto(path);
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
      // On the one-line layout a chip beside pills has a line of its own,
      // because every row shares the columns (#5006). The author and dates
      // then centre on both lines.
      await expect
        .poll(async () =>
          (await measure(page)).flatMap((m) => {
            const pill = m.centres['.ci-pill'];
            const stacked = m.centres['.wait-chip'] - pill > TOLERANCE;
            const beside = ['.review-pill', '.row-action-bar'];
            return Object.entries(m.centres)
              .filter(([n]) => !stacked || beside.includes(n))
              .filter(([n]) => !phone || ['.review-pill'].includes(n))
              .filter(
                ([n, c]) => n !== '.ci-pill' && Math.abs(c - pill) > TOLERANCE,
              )
              .map(([n, c]) => `${m.title}: ${n} ${c} vs status pill ${pill}`);
          }),
        )
        .toEqual([]);
    });

    test('a chip beside pills adds one line at most', async ({ page }) => {
      test.skip(width < 600, 'a phone card has its own tiers');
      await expect
        .poll(async () => {
          const m = await measure(page);
          const h = (t: string) => m.find((x) => x.title.endsWith(t))!.height;
          return [
            h('Waiting chip') - h('Merge'),
            h('Labels under the title') - h('Labels with Merge'),
          ].every((d) => d <= 36);
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

// A chip beside Update branch (about 100px) would leave the title under 200px,
// so below 94rem it keeps a line of its own under the pills. That is the one
// documented exception to "every cell shares the middle": the pills and the
// action share the first line, the chip sits below them and the author and
// dates centre on both lines. The centring
// test above leaves this row out for that reason.
for (const width of [1280, 1503]) {
  test(`a chip stacked under the pills and Update branch: pills and action share a line at ${width}px`, async ({
    page,
  }) => {
    const stacked = pr(7, {
      title: 'Stacked chip',
      ...COMMENTS,
      ...RUNNING,
      behind: true,
      autoMergeEnabled: true,
      autoMerge: WAITING,
      allowedActions: [
        { action: 'update_branch', primary: true },
        { action: 'cancel_auto_merge' },
        { action: 'close' },
      ],
    });
    await open(page, width, [stacked]);
    await expect
      .poll(async () => {
        const [m] = await measure(page);
        const pill = m.centres['.ci-pill'];
        const near = (n: string) => Math.abs(m.centres[n] - pill) <= TOLERANCE;
        return [
          near('.review-pill'),
          near('.row-action-bar'),
          m.centres['.wait-chip'] - pill > 10,
        ];
      })
      .toEqual([true, true, true]);
  });
}

// The title floor of #4795: a chip with pills and one action leaves the title
// 200px or more at 1280px. The rule is a 200px title floor except bot rows: a
// bot row's rebase button with an unarmed chip keeps 145px (see
// merge-wait-chip.spec.ts).
test('a chip with pills and one action leaves the title 200px at 1280px', async ({
  page,
}) => {
  await open(page, 1280);
  for (const title of ['Waiting chip']) {
    const width = await page
      .locator('#pr-rows > .row', { hasText: title })
      .locator('.title-cell')
      .evaluate((e) => e.clientWidth);
    expect(width, title).toBeGreaterThanOrEqual(200);
  }
});

// A bot's rebase (in the bar) and Cancel (in the chip) with pills and a chip stack the chip under the
// pills, like Update branch above, and every part stays visible.
for (const width of [1280, 1503]) {
  test(`a stacked bot row shows the pills, rebase and Cancel at ${width}px`, async ({
    page,
  }) => {
    const bot = pr(8, {
      title: 'Stacked bot',
      author: 'dependabot[bot]',
      kind: 'dependency',
      ...COMMENTS,
      ...RUNNING,
      behind: true,
      autoMergeEnabled: true,
      autoMerge: WAITING,
      allowedActions: [
        { action: 'dependabot_rebase', primary: true },
        { action: 'cancel_auto_merge' },
        { action: 'close' },
      ],
    });
    await open(page, width, [bot], '/bots.html');
    const row = page.locator('#pr-rows > .row');
    await expect(row.locator('.ci-pill')).toBeVisible();
    await expect(row.locator('.review-pill')).toBeVisible();
    const chip = row.locator('.wait-chip');
    await expect(chip).toBeVisible();
    await expect(
      row.locator('.row-action-bar').getByRole('button', { name: /Rebase/ }),
    ).toBeVisible();
    await expect(
      chip.getByRole('button', { name: /^Cancel auto-merge/ }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const [m] = await measure(page);
        return m.centres['.wait-chip'] - m.centres['.ci-pill'] > 10;
      })
      .toBe(true);
  });
}
