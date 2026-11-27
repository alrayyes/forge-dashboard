import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { routeImage } from './proxied-image';
import { test } from './server-fixture';

// The one-line pull request row gave the repo column 168px at every width, so
// a 1920px window cut repository names beside a title track of about 800px.
// The column now grows with the list once the title has room to spare.
// https://github.com/alrayyes/forge-dashboard/issues/470

// 34 characters each, the longest the column has to show whole.
const NAME_34 = 'example-org/payment-webhook-worker';
const OTHER_34 = 'example-org/customer-export-runner';
const TOO_LONG =
  'example-org/an-unusually-long-repository-name-that-no-column-should-hold';

const LOGO_URL = 'https://example.com/logo.png';
const LOGO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function pr(number: number, repo: string, over: Record<string, unknown> = {}) {
  return {
    forge: 'forgejo',
    repo,
    number,
    title: `fix(api): retry a webhook delivery that timed out (${number})`,
    url: `https://example.com/pull/${number}`,
    author: 'demo-user',
    draft: false,
    ci: 'success',
    checks: { passed: 8, running: 0, waiting: 0, failed: 0 },
    labels: [],
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    allowedActions: [{ action: 'merge', primary: true }, { action: 'close' }],
    ...over,
  };
}

// An armed row with a comment pill: the widest status cell the one-line row
// draws, so the one that leaves the title the least.
const ARMED = {
  ci: 'pending',
  checks: { passed: 4, running: 2, waiting: 3, failed: 0 },
  mergeStatus: 'blocked',
  reviewComments: 4,
  unresolvedThreads: 1,
  autoMergeEnabled: true,
  autoMerge: {
    state: 'waiting',
    code: 'checks_pending',
    message: 'Auto-merge is waiting for checks to finish.',
  },
  allowedActions: [
    { action: 'merge' },
    { action: 'cancel_auto_merge' },
    { action: 'close' },
  ],
};

const PRS = [
  pr(1, NAME_34),
  pr(2, OTHER_34, ARMED),
  pr(3, 'demo/api'),
  pr(4, TOO_LONG),
];
const BOT_PRS = PRS.map((p) => ({
  ...p,
  author: 'renovate[bot]',
  kind: 'dependency',
}));
const RELEASE_PRS = PRS.map((p, i) => ({
  ...p,
  title: `chore(main): release 1.2.${i}`,
  kind: 'release',
}));
const ISSUES = [NAME_34, OTHER_34, 'demo/api', TOO_LONG].map((repo, i) => ({
  forge: 'forgejo',
  repo,
  number: i + 1,
  title: `Webhook deliveries time out under load (${i + 1})`,
  url: `https://example.com/issues/${i + 1}`,
  author: 'demo-user',
  labels: [],
  createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  updatedAt: new Date(Date.now() - (i + 1) * 1000).toISOString(),
}));

const ROWS = '#pr-rows .row, #issue-rows .row';

async function open(
  page: Page,
  width: number,
  {
    path = '/pull-requests.html',
    groupBy = '',
  }: { path?: string; groupBy?: string } = {},
) {
  await page.setViewportSize({ width, height: 900 });
  const prs =
    path === '/bots.html'
      ? BOT_PRS
      : path === '/releases.html'
        ? RELEASE_PRS
        : PRS;
  const issues = path === '/issues.html' ? ISSUES : [];
  await routeImage(
    page,
    LOGO_URL,
    (route: Route) => route.fulfill({ contentType: 'image/png', body: LOGO }),
    'forgejo',
  );
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('forgejo')],
        pullRequests: prs,
        issues,
        // A logo takes room from the name, so measure with one.
        repos: prs.map((p) => ({
          forge: p.forge,
          fullName: p.repo,
          logoUrl: LOGO_URL,
        })),
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(path);
  await expect(page.locator(ROWS)).toHaveCount(prs.length);
  if (groupBy) {
    await page.locator('#shared-group-select').selectOption(groupBy);
    await expect(page.locator('.group-heading').first()).toBeVisible();
  }
  await expect(
    page.locator('#pr-rows .repo-logo, #issue-rows .repo-logo'),
  ).toHaveCount(prs.length);
  await page.evaluate(() => document.fonts.ready);
}

function measure(page: Page) {
  return page.locator(ROWS).evaluateAll((rows) =>
    rows.map((row) => {
      const name = row.querySelector('.repo-name') as HTMLElement;
      return {
        name: name.textContent ?? '',
        cut: name.scrollWidth > name.clientWidth,
        ellipsis: getComputedStyle(name).textOverflow,
        hover: name.getAttribute('title'),
        repo: (
          row.querySelector('.repo') as HTMLElement
        ).getBoundingClientRect().width,
        title: (
          row.querySelector('.title-cell') as HTMLElement
        ).getBoundingClientRect().width,
        overflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    }),
  );
}

const oneWidth = (rows: { repo: number }[]) =>
  new Set(rows.map((r) => Math.round(r.repo))).size;

// The view, how to open it, and the repo column's width at 1280px: what it
// was before it grew.
const VIEWS = [
  ['Pull requests', {}, 168],
  ['grouped by repository', { groupBy: 'repo' }, 168],
  ['Bots', { path: '/bots.html' }, 168],
  ['Releases', { path: '/releases.html' }, 168],
  ['Issues', { path: '/issues.html' }, 280],
  ['Issues grouped', { path: '/issues.html', groupBy: 'repo' }, 280],
] as const;

for (const [view, options, narrow] of VIEWS) {
  for (const width of [1920, 2560]) {
    test(`${view}: a 34 character repository name shows whole at ${width}px`, async ({
      page,
    }) => {
      await open(page, width, options);
      await expect
        .poll(async () =>
          (await measure(page))
            .filter((r) => r.name.length === 34)
            .map((r) => ({ cut: r.cut, hover: r.hover })),
        )
        .toEqual([
          { cut: false, hover: null },
          { cut: false, hover: null },
        ]);
      const rows = await measure(page);
      expect(oneWidth(rows)).toBe(1);
      expect(rows[0].overflow).toBeLessThanOrEqual(0);
    });
  }

  test(`${view}: at 1280px the repo column stays ${narrow}px`, async ({
    page,
  }) => {
    await open(page, 1280, options);
    const rows = await measure(page);
    expect(rows.map((r) => Math.round(r.repo))).toEqual(Array(4).fill(narrow));
  });
}

test('at 1280px the title column is no narrower than 220px', async ({
  page,
}) => {
  await open(page, 1280);
  const rows = await measure(page);
  // The armed row's wider status cell takes from its own title (#4541), so
  // the plain rows carry this one.
  expect(rows.find((r) => r.name === NAME_34)?.title).toBeGreaterThanOrEqual(
    220,
  );
});

for (const width of [1280, 1600, 1920, 2560]) {
  test(`Issues at ${width}px: the columns line up and the title stays readable`, async ({
    page,
  }) => {
    await open(page, width, { path: '/issues.html' });
    const rows = await measure(page);
    expect(oneWidth(rows)).toBe(1);
    expect(rows[0].overflow).toBeLessThanOrEqual(0);
    // 560px is what the title had at 1280px, and it keeps at least that.
    for (const r of rows) expect(r.title).toBeGreaterThanOrEqual(559.5);
  });
}

// 1600px is where the column starts to grow and 1664px where the list passes
// 94rem and the waiting chip moves beside the pills (#4784).
for (const width of [1280, 1503, 1600, 1601, 1664, 1700, 1800, 1920, 2560]) {
  test(`at ${width}px the columns line up and the title keeps its room`, async ({
    page,
  }) => {
    await open(page, width);
    const rows = await measure(page);
    expect(oneWidth(rows)).toBe(1);
    expect(rows[0].overflow).toBeLessThanOrEqual(0);
    // What the plain row's title had at each of these widths before the
    // column grew is 440px from 1600px up, and it keeps at least that.
    if (width >= 1600) expect(rows[0].title).toBeGreaterThanOrEqual(439.5);
    if (width >= 1600)
      for (const r of rows) expect(r.title).toBeGreaterThanOrEqual(200);
  });
}

for (const path of ['/pull-requests.html', '/issues.html']) {
  test(`${path}: a name too long for the column ends in an ellipsis, with the full name on hover`, async ({
    page,
  }) => {
    await open(page, 1920, { path });
    await expect
      .poll(async () => (await measure(page)).find((r) => r.name === TOO_LONG))
      .toMatchObject({ cut: true, ellipsis: 'ellipsis', hover: TOO_LONG });
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 1920]) {
      test(`${path}: no axe violations in ${scheme} at ${width}px`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await open(page, width, { path });
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
}
