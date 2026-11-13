import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3398
//
// Text follows the browser's default font size. Raising the root font size to
// 200% (the "Very large" setting) doubles body, row and label text with no
// sideways scroll at 640px, and at the default size every computed font size
// is what it was when the sheet was written in px (1rem = 16px).

const ago = (seconds: number) =>
  new Date(Date.now() - seconds * 1000).toISOString();

async function routeDashboard(page: Page) {
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
        pullRequests: [
          {
            forge: 'github',
            repo: 'alrayyes/app',
            number: 1,
            title: 'Make the text follow the browser setting',
            url: 'https://example.test/alrayyes/app/pull/1',
            author: 'claude',
            draft: false,
            ci: 'success',
            checks: { passed: 4, running: 0, waiting: 0, failed: 0 },
            labels: [{ name: 'bug', color: 'd73a4a' }],
            createdAt: ago(0),
            updatedAt: ago(100),
            mergeStatus: 'mergeable',
          },
        ],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

// Selector -> computed font size in px.
const PROBES = [
  'h1',
  '.header-status .mono',
  '#pr-rows .repo-name',
  '#pr-rows .title-text',
  '#pr-rows .num',
  '#pr-rows .label-chip',
  '#pr-rows .author-name',
  '#pr-rows .time-label',
  '#pr-rows .time-value',
  '#pr-rows .ci-pill',
  '#pr-rows .row-action',
  '#pr-rows .forge-badge',
];

async function sizes(page: Page, selectors: string[]) {
  return page.evaluate(
    (sels) =>
      Object.fromEntries(
        sels.map((s) => {
          const el = document.querySelector(s);
          return [s, el ? getComputedStyle(el).fontSize : 'missing'];
        }),
      ),
    selectors,
  );
}

async function open(page: Page) {
  await routeDashboard(page);
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row').first()).toBeVisible();
}

test('at the default size computed font sizes are unchanged', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  // Retries until the stylesheet has applied to every probe.
  await expect.poll(() => sizes(page, PROBES)).toEqual(BASELINE);
});

test('a 200% root font size doubles the text without sideways scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await open(page);
  const before = await sizes(page, PROBES);

  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  // Retries until the injected rule has been applied to every probe, then
  // names the probes that did not double.
  await expect
    .poll(async () => {
      const after = await sizes(page, PROBES);
      return PROBES.filter(
        (sel) =>
          Math.abs(parseFloat(after[sel]) - parseFloat(before[sel]) * 2) > 0.05,
      );
    })
    .toEqual([]);

  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scroll, 'page scrolls sideways').toBeLessThanOrEqual(client);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

// Captured from the px sheet before the conversion.
const BASELINE: Record<string, string> = {
  h1: '19px',
  '.header-status .mono': '12px',
  '#pr-rows .repo-name': '12.5px',
  '#pr-rows .title-text': '13.5px',
  '#pr-rows .num': '12px',
  '#pr-rows .label-chip': '10.5px',
  '#pr-rows .author-name': '12.5px',
  '#pr-rows .time-label': '10.5px',
  '#pr-rows .time-value': '12px',
  '#pr-rows .ci-pill': '11.5px',
  '#pr-rows .row-action': '11.5px',
  '#pr-rows .forge-badge': '11px',
};

for (const route of ['/', '/issues.html', '/settings.html']) {
  test(`${route} has no sideways scroll at a 200% root font size and 640px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 800 });
    await routeDashboard(page);
    await page.goto(route);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await expect(page.locator('h1').first()).toBeVisible();
    const [scroll, client] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(scroll, 'page scrolls sideways').toBeLessThanOrEqual(client);
  });
}

// Larger text must wrap or shrink inside the viewport, not push the page
// sideways. The mock carries a regular, a dependency and a release pull
// request, an issue and repos with and without a webhook, so every page below
// draws the rows and controls that carry fixed widths.
const pr = (n: number, extra: Record<string, unknown>) => ({
  forge: 'github',
  repo: 'alrayyes/app',
  number: n,
  title: `Pull request ${n} with a title long enough to need wrapping`,
  url: `https://example.test/alrayyes/app/pull/${n}`,
  author: 'claude',
  draft: false,
  ci: 'success',
  checks: { passed: 4, running: 0, waiting: 0, failed: 0 },
  labels: [{ name: 'bug', color: 'd73a4a' }],
  createdAt: ago(0),
  updatedAt: ago(100),
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
  ...extra,
});

async function routeRich(page: Page) {
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
        pullRequests: [
          pr(1, {}),
          pr(2, {
            title: 'Bump package from 1.0.0 to 1.0.1',
            author: 'dependabot',
            kind: 'dependency',
          }),
          pr(3, {
            title: 'chore(main): release 0.3.0',
            author: 'release-please[bot]',
            kind: 'release',
            labels: [{ name: 'autorelease: pending', color: 'ededed' }],
          }),
        ],
        issues: [
          {
            forge: 'github',
            repo: 'alrayyes/app',
            number: 9,
            title: 'An issue with a title long enough to need wrapping',
            url: 'https://example.test/alrayyes/app/issues/9',
            author: 'claude',
            labels: [{ name: 'bug', color: 'd73a4a' }],
            createdAt: ago(0),
            updatedAt: ago(100),
          },
        ],
        openIssueCount: 1,
        repos: [
          {
            forge: 'github',
            fullName: 'alrayyes/forge-dashboard',
            hasWebhook: true,
          },
          {
            forge: 'github',
            fullName: 'alrayyes/gamma',
            hasWebhook: false,
            canManageWebhooks: true,
            autoUpdateBranch: true,
            rebaseBots: true,
          },
        ],
        hiddenDrafts: 0,
        firstRefreshDone: true,
      }),
    }),
  );
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 1,
          passed: 0,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: 1,
        },
        branches: [
          {
            forge: 'github',
            fullName: 'acme/ingress-controller',
            url: 'https://example.test/acme/ingress-controller',
            branch: 'main',
            status: 'failed',
            commit: {
              sha: 'd98f3c2',
              subject: 'fix: change in the ingress controller',
              author: 'sre-dev',
              committedAt: ago(1800),
            },
            failingJobs: ['lint', 'e2e-playwright'],
            finishedAt: ago(700),
            durationSeconds: 252,
            runUrl: 'https://example.test/acme/ingress-controller/runs/1',
            staleSince: null,
          },
        ],
      }),
    }),
  );
}

const WIDE_PAGES = [
  '/pull-requests.html',
  '/issues.html',
  '/webhooks.html',
  '/insights.html',
  '/bots.html',
  '/releases.html',
];

const SCALES: [number, number][] = [
  [320, 200],
  [320, 400],
  [640, 400],
];

for (const route of WIDE_PAGES) {
  for (const [width, pct] of SCALES) {
    test(`${route} has no sideways scroll at ${pct}% and ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await routeRich(page);
      await page.goto(route);
      await page.addStyleTag({
        content: `html { font-size: ${pct}% !important; }`,
      });
      await expect(page.locator('h1').first()).toBeVisible();
      await page.waitForTimeout(300);
      const [scroll, client] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      expect(scroll, 'page scrolls sideways').toBeLessThanOrEqual(client);
    });
  }
}

// The bottom tab bar already overflows at 400% and 320px, so Branches is
// probed at 200% only.
test('/ has no sideways scroll at 200% and 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await routeRich(page);
  await page.goto('/');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  await expect(
    page.locator('[data-testid="main-branch-row"]').first(),
  ).toBeVisible();
  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scroll, 'page scrolls sideways').toBeLessThanOrEqual(client);
});
