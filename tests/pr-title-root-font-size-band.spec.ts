import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3849
//
// At 150% and 175% the compact layout of the Pull requests list switched on
// too late: between that point and the width where every column fits, the
// title was squeezed to about 100px. The threshold now follows the title's
// minimum instead of a fixed rem.

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
        forges: [forgeHealth('github')],
        pullRequests: [
          {
            forge: 'github',
            repo: 'alrayyes/app',
            number: 1,
            title:
              'Keep the date columns apart when the title is long enough that it needs several lines at this width',
            url: 'https://example.test/alrayyes/app/pull/1',
            author: 'claude',
            draft: false,
            ci: 'success',
            checks: { passed: 4, running: 0, waiting: 0, failed: 0 },
            labels: [{ name: 'bug', color: 'd73a4a' }],
            createdAt: ago(3 * 86400),
            updatedAt: ago(100),
            mergeStatus: 'mergeable',
          },
        ],
        issues: [
          {
            forge: 'github',
            repo: 'alrayyes/app',
            number: 9,
            title:
              'Keep the date columns apart when the title is long enough that it needs several lines at this width',
            url: 'https://example.test/alrayyes/app/issues/9',
            author: 'claude',
            labels: [{ name: 'bug', color: 'd73a4a' }],
            createdAt: ago(3 * 86400),
            updatedAt: ago(100),
          },
        ],
        openIssueCount: 1,
        repos: [],
        hiddenDrafts: 0,
        firstRefreshDone: true,
      }),
    }),
  );
}

async function open(
  page: Page,
  path: string,
  rows: string,
  percent: number,
  width: number,
) {
  await page.setViewportSize({ width, height: 800 });
  await routeDashboard(page);
  await page.goto(path);
  await expect(page.locator(`${rows} > .row`).first()).toBeVisible();
  if (percent !== 100) {
    await page.addStyleTag({
      content: `html { font-size: ${percent}% !important; }`,
    });
  }
}

const measure = (page: Page, rows: string) =>
  page.evaluate((sel) => {
    const row = document.querySelector(`${sel} > .row`) as HTMLElement;
    const title = row.querySelector('.title-cell') as HTMLElement;
    return {
      title: title.getBoundingClientRect().width,
      scroll: row.scrollWidth,
      client: row.clientWidth,
      tracks: getComputedStyle(row).gridTemplateColumns,
    };
  }, rows);

// Re-measures until every check holds, so a row still settling after a render
// under load doesn't fail the spec on a one-shot read.
async function expectMeasure(
  page: Page,
  rows: string,
  checks: (m: Awaited<ReturnType<typeof measure>>) => [string, boolean][],
) {
  await expect
    .poll(async () => {
      const m = await measure(page, rows);
      return checks(m)
        .filter(([, ok]) => !ok)
        .map(([what]) => `${what} (${JSON.stringify(m)})`);
    })
    .toEqual([]);
}

const PR = '#pr-rows';
const ISSUES = '#issue-rows';

for (const percent of [150, 175]) {
  for (const width of [1100, 1104, 1150, 1200, 1250, 1300]) {
    test(`Pull requests: the title is 200px or more at ${percent}% and ${width}px`, async ({
      page,
    }) => {
      await open(page, '/pull-requests.html', PR, percent, width);
      await expectMeasure(page, PR, (m) => [
        ['title is under 200px', m.title >= 200],
        ['row scrolls sideways', m.scroll <= m.client],
      ]);
    });
  }

  // The full layout (author and dates) stays where it fits.
  test(`Pull requests: the full layout stays at ${percent}% and 1280px`, async ({
    page,
  }) => {
    await open(page, '/pull-requests.html', PR, percent, 1280);
    await expectMeasure(page, PR, (m) => [
      ['not seven tracks', m.tracks.split(' ').length === 7],
      ['title is under 200px', m.title >= 200],
    ]);
  });

  // The Issues list was already fine; the later switch is for pull requests.
  test(`Issues: the full layout stays at ${percent}% and 1150px`, async ({
    page,
  }) => {
    await open(page, '/issues.html', ISSUES, percent, 1150);
    await expectMeasure(page, ISSUES, (m) => [
      ['not six tracks', m.tracks.split(' ').length === 6],
      ['title is under 300px', m.title >= 300],
    ]);
    await expect(
      page.locator(`${ISSUES} > .row .created`).first(),
    ).toBeVisible();
  });
}

test('Pull requests: the tracks are unchanged at 100%', async ({ page }) => {
  // Phone, then compact up to 1103px, then the full seven tracks.
  const expected: Record<number, number> = {
    320: 2,
    390: 2,
    761: 4,
    1103: 4,
    1104: 7,
    1280: 7,
  };
  for (const width of [320, 390, 761, 1103, 1104, 1280]) {
    await open(page, '/pull-requests.html', PR, 100, width);
    await expect
      .poll(async () => (await measure(page, PR)).tracks.split(' ').length)
      .toBe(expected[width]);
  }
});

test('Pull requests: the 100% track widths at 1104px and 1280px are unchanged', async ({
  page,
}) => {
  await open(page, '/pull-requests.html', PR, 100, 1280);
  await expect
    .poll(async () => (await measure(page, PR)).tracks)
    .toBe('280px 268px 96px 82px 82px 280px 22px');
  await open(page, '/pull-requests.html', PR, 100, 1104);
  await expect
    .poll(async () => {
      const tracks = (await measure(page, PR)).tracks.split(' ');
      return tracks.slice(0, 1).concat(tracks.slice(2));
    })
    .toEqual(['280px', '96px', '82px', '82px', '280px', '22px']);
});

for (const [name, path, rows] of [
  ['Issues', '/issues.html', ISSUES],
  ['Pull requests', '/pull-requests.html', PR],
] as const) {
  for (const percent of [150, 175]) {
    for (const mode of ['light', 'dark', 'forced-colors'] as const) {
      test(`${name}: axe finds nothing at ${percent}% in ${mode}`, async ({
        page,
      }) => {
        if (mode === 'forced-colors') {
          await page.emulateMedia({ forcedColors: 'active' });
        } else {
          await page.emulateMedia({ colorScheme: mode });
        }
        await open(page, path, rows, percent, 1150);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
}
