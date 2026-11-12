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
  expect(await sizes(page, PROBES)).toEqual(BASELINE);
});

test('a 200% root font size doubles the text without sideways scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await open(page);
  const before = await sizes(page, PROBES);

  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  const after = await sizes(page, PROBES);
  for (const sel of PROBES) {
    const was = parseFloat(before[sel]);
    expect(parseFloat(after[sel]), `${sel} grows from ${was}px`).toBeCloseTo(
      was * 2,
      1,
    );
  }

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
