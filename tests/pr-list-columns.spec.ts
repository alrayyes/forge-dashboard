import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The pull request list is one grid and every row a subgrid of it, so a column
// is sized once for all rows: author, dates, check pill, comment pill and
// action start at the same x whatever a row holds. Before, each row was a grid
// of its own and a long check pill or a waiting chip moved that row's columns.
// https://github.com/alrayyes/forge-dashboard/issues/5006

const COMMENTS = { reviewComments: 4, unresolvedThreads: 1 };
const LABELS = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'needs-review', color: 'fbca04' },
];
const WAIT_BLOCK = {
  code: 'checks_pending',
  message: 'Waiting for CI to finish',
};
const MERGE = {
  allowedActions: [{ action: 'merge', primary: true }, { action: 'close' }],
};
const RUNNING = {
  ci: 'pending',
  checks: { passed: 4, running: 2, waiting: 0, failed: 0 },
};
// A pill with more counts than the 10.25rem slot holds.
const LONG_PILL = {
  ci: 'failure',
  checks: { passed: 128, running: 17, waiting: 12, failed: 23, skipped: 9 },
};

function pr(number: number, title: string, over: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'example-org/api-gateway',
    number,
    title,
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
    ...MERGE,
    ...over,
  };
}

const offered = {
  ...RUNNING,
  mergeStatus: 'blocked',
  status: WAIT_BLOCK,
  allowedActions: [
    { action: 'merge', blocked: WAIT_BLOCK },
    { action: 'auto_merge' },
    { action: 'close' },
  ],
};
const armed = {
  ...offered,
  autoMergeEnabled: true,
  autoMerge: {
    state: 'waiting',
    code: 'checks_pending',
    message: 'Auto-merge is waiting for the checks to finish.',
  },
  allowedActions: [
    { action: 'merge', blocked: WAIT_BLOCK },
    { action: 'cancel_auto_merge' },
    { action: 'close' },
  ],
};

const ROWS = [
  pr(1, 'Plain row'),
  pr(2, 'Long check pill', { ...LONG_PILL, ...COMMENTS }),
  pr(3, 'Waiting chip', offered),
  pr(4, 'Waiting chip with comments', { ...offered, ...COMMENTS }),
  pr(5, 'Armed chip', armed),
  pr(6, 'Labels and comments', { labels: LABELS, ...COMMENTS }),
  pr(7, 'Update branch beside Merge', {
    behind: true,
    allowedActions: [
      { action: 'merge', primary: true },
      { action: 'update_branch' },
      { action: 'close' },
    ],
  }),
  pr(8, 'Conflicting with comments', {
    mergeStatus: 'conflicting',
    conflictConfirmed: true,
    ...COMMENTS,
  }),
  pr(9, 'No action', {
    ci: 'failure',
    checks: { passed: 8, running: 0, waiting: 0, failed: 3 },
    allowedActions: [{ action: 'close' }],
  }),
  pr(
    10,
    'fix(parser): handle nested lists with mixed indentation and a very long title that has to be cut somewhere along the row',
    { author: 'a-very-long-author-name-indeed', ...COMMENTS },
  ),
];

// The stream is kept so a test can push a second snapshot into the same page,
// as the server does.
function snapshot(pullRequests: unknown[]) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [forgeHealth('github')],
    pullRequests,
    issues: [],
    openIssueCount: 0,
    repos: [],
    hiddenDrafts: 0,
  };
}

async function open(
  page: Page,
  width: number,
  prs: unknown[] = ROWS,
  path = '/pull-requests.html',
) {
  await page.setViewportSize({ width, height: 1200 });
  await page.addInitScript(() => {
    const w = window as unknown as {
      __streams: EventSource[];
      EventSource: typeof EventSource;
    };
    w.__streams = [];
    const Real = w.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        w.__streams.push(this);
      }
    };
  });
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(prs)),
    }),
  );
  await page.goto(path);
  await expect(page.locator('#pr-rows .row')).toHaveCount(prs.length);
}

async function push(page: Page, prs: unknown[]) {
  await page.evaluate(
    (data) => {
      const w = window as unknown as { __streams: EventSource[] };
      for (const stream of w.__streams)
        stream.onmessage?.(new MessageEvent('message', { data }));
    },
    JSON.stringify(snapshot(prs)),
  );
}

const CELLS = {
  author: '.author',
  created: '.created',
  updated: '.updated',
  'check pill': '.ci-pill',
  'comment pill': '.status-flags',
  action: '.row-action-bar',
};

interface Row {
  title: string;
  height: number;
  titleWidth: number;
  lefts: Record<string, number>;
  boxes: { name: string; l: number; r: number; t: number; b: number }[];
}

function measure(page: Page): Promise<Row[]> {
  return page.locator('#pr-rows .row').evaluateAll((rows, cells) => {
    return rows.map((r) => {
      const rowBox = r.getBoundingClientRect();
      const lefts: Record<string, number> = {};
      for (const [name, selector] of Object.entries(cells)) {
        const e = r.querySelector(selector);
        const box = e?.getBoundingClientRect();
        if (box && box.width > 0) lefts[name] = box.left;
      }
      // What a person sees side by side. None of them may cover another.
      const boxes = [
        '.repo',
        '.title-cell',
        '.author',
        '.created',
        '.updated',
        '.ci-pill',
        '.wait-chip',
        '.status-flags .review-pill',
        '.status-flags .merge-pill',
        '.row-action-bar .row-action',
        '.go',
      ].flatMap((selector) =>
        Array.from(r.querySelectorAll(selector))
          .map((e) => e.getBoundingClientRect())
          .filter((b) => b.width > 0 && b.height > 0)
          .map((b) => ({
            name: selector,
            l: b.left - rowBox.left,
            r: b.right - rowBox.left,
            t: b.top - rowBox.top,
            b: b.bottom - rowBox.top,
          })),
      );
      return {
        title: r.querySelector('.title-text')?.textContent?.slice(0, 30) ?? '',
        height: rowBox.height,
        titleWidth: r.querySelector('.title-cell')?.clientWidth ?? 0,
        lefts,
        boxes,
      };
    });
  }, CELLS);
}

// Each cell whose left edge differs from the first row that has that cell.
function misaligned(rows: Row[]): string[] {
  return Object.keys(CELLS).flatMap((name) => {
    const have = rows.filter((r) => name in r.lefts);
    return have
      .filter((r) => Math.abs(r.lefts[name] - have[0].lefts[name]) > 0.5)
      .map(
        (r) => `${r.title}: ${name} ${r.lefts[name]} ${have[0].lefts[name]}`,
      );
  });
}

function overlaps(rows: Row[]): string[] {
  return rows.flatMap((row) =>
    row.boxes.flatMap((a, i) =>
      row.boxes
        .slice(i + 1)
        .filter(
          (b) =>
            a.l < b.r - 0.5 &&
            b.l < a.r - 0.5 &&
            a.t < b.b - 0.5 &&
            b.t < a.b - 0.5,
        )
        .map((b) => `${row.title}: ${a.name} covers ${b.name}`),
    ),
  );
}

// A bot row's actions are the widest the column holds: Merge beside
// Dependabot's split button, or beside the cancel of a Renovate rebase.
const dependabot = {
  author: 'dependabot[bot]',
  kind: 'dependency',
  behind: true,
  allowedActions: [
    { action: 'merge', primary: true },
    { action: 'dependabot_rebase' },
    { action: 'dependabot_recreate' },
    { action: 'close' },
  ],
};
const renovate = {
  author: 'renovate[bot]',
  kind: 'dependency',
  behind: true,
  allowedActions: [
    { action: 'merge', primary: true },
    { action: 'cancel_renovate_rebase' },
    { action: 'close' },
  ],
};
const BOT_ROWS = [
  pr(30, 'Dependabot behind', dependabot),
  pr(31, 'Renovate rebase requested', renovate),
  pr(32, 'Dependabot with comments', { ...dependabot, ...COMMENTS }),
  pr(33, 'Renovate with a long pill', {
    ...renovate,
    ...LONG_PILL,
    ...COMMENTS,
  }),
  pr(34, 'Plain bot row', {
    author: 'renovate[bot]',
    kind: 'dependency',
  }),
  pr(35, 'Another plain bot row', {
    author: 'dependabot[bot]',
    kind: 'dependency',
    ...COMMENTS,
  }),
];

const LISTS = [
  { list: 'pull requests', path: '/pull-requests.html', prs: ROWS },
  { list: 'bots', path: '/bots.html', prs: BOT_ROWS },
];

for (const scheme of ['light', 'dark'] as const) {
  for (const { list, path, prs } of LISTS) {
    for (const width of [1253, 1280, 1503, 1920]) {
      test.describe(`${list}, ${scheme}, ${width}px`, () => {
        test.beforeEach(async ({ page }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await open(page, width, prs, path);
        });

        test('every column starts at the same x on every row', async ({
          page,
        }) => {
          // The wide layout is on, and every cell is on more than one row.
          await expect(page.locator('#pr-rows')).toHaveCSS('display', 'grid');
          const rows = await measure(page);
          for (const name of Object.keys(CELLS))
            expect(
              rows.filter((r) => name in r.lefts).length,
              name,
            ).toBeGreaterThan(2);
          await expect
            .poll(async () => misaligned(await measure(page)))
            .toEqual([]);
        });

        test('nothing overlaps, nothing scrolls sideways, titles keep 200px', async ({
          page,
        }) => {
          await expect
            .poll(async () => overlaps(await measure(page)))
            .toEqual([]);
          for (const selector of ['html', '#pr-rows'])
            expect(
              await page
                .locator(selector)
                .evaluate((e) => e.scrollWidth - e.clientWidth),
              selector,
            ).toBeLessThanOrEqual(0);
          for (const r of await measure(page))
            expect(r.titleWidth, r.title).toBeGreaterThanOrEqual(200);
        });

        test('the list has no axe violations', async ({ page }) => {
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .analyze();
          expect(results.violations).toEqual([]);
        });
      });
    }
  }
}

for (const width of [1280, 1503, 1920]) {
  test(`a live update to one row's counts leaves the others where they were, ${width}px`, async ({
    page,
  }) => {
    await open(page, width, [
      pr(1, 'Changes', RUNNING),
      pr(2, 'Stays', COMMENTS),
    ]);
    const lefts = async () =>
      (await measure(page)).find((r) => r.title === 'Stays')?.lefts;
    const before = await lefts();

    await push(page, [
      pr(1, 'Changes', {
        ci: 'pending',
        checks: { passed: 5, running: 1, waiting: 0, failed: 0 },
      }),
      pr(2, 'Stays', COMMENTS),
    ]);

    await expect(
      page
        .locator('#pr-rows > .row', { hasText: 'Changes' })
        .locator('.ci-pill'),
    ).toContainText('5');
    expect(await lefts()).toEqual(before);
  });
}

// A stack nests its rows in a list and a grouped list adds headings, and both
// still share the list's columns.
const STACKED = [
  pr(20, 'Not stacked', COMMENTS),
  pr(21, 'Bottom of the stack', {
    stack: { position: 1, size: 2 },
    stackChildren: [22],
    ...LONG_PILL,
    ...COMMENTS,
  }),
  pr(22, 'Top of the stack', {
    stack: { position: 2, size: 2 },
    stackedOn: { number: 21, url: 'https://example.com/pull/21' },
    ...COMMENTS,
  }),
  pr(23, 'Another repository', { repo: 'example-org/web', ...offered }),
];

for (const width of [1280, 1920]) {
  test(`stacked and grouped rows keep the list's columns, ${width}px`, async ({
    page,
  }) => {
    await open(page, width, STACKED);
    await expect(page.locator('#pr-rows .stack-member > .row')).toHaveCount(2);
    await expect.poll(async () => misaligned(await measure(page))).toEqual([]);

    await page.getByLabel('Group rows by').selectOption('repo');
    await expect(page.locator('#pr-rows > .group-heading')).toHaveCount(2);
    await expect.poll(async () => misaligned(await measure(page))).toEqual([]);
    expect(overlaps(await measure(page))).toEqual([]);
  });
}

// Row heights of these rows before the change, in the order of ROWS. Under
// 1191px of list width and on a phone no row may grow.
const HEIGHTS = {
  1190: [85, 78, 85, 85, 85, 85, 85, 127, 54, 84],
  1024: [85, 78, 85, 85, 85, 85, 85, 127, 49, 84],
  861: [85, 78, 85, 85, 85, 85, 85, 127, 49, 84],
  820: [85, 86, 85, 114, 85, 85, 85, 144.5, 49, 84],
  390: [225, 210, 225, 225, 225, 249, 225, 213, 160, 299],
};

for (const [width, before] of Object.entries(HEIGHTS)) {
  test(`rows are no taller than before at ${width}px`, async ({ page }) => {
    await open(page, Number(width));
    await expect
      .poll(async () =>
        (await measure(page)).flatMap((r, i) =>
          r.height > before[i] + 1
            ? [`${r.title}: ${r.height} was ${before[i]}`]
            : [],
        ),
      )
      .toEqual([]);
  });
}
