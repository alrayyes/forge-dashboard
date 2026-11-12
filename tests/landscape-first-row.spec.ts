import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';
import { settle } from './settle-helper';
import { setTheme } from './theme-helper';

// A phone held sideways is 390px (or 375px) tall. The header, Activity row,
// status row and filter bar used to fill that, so no list row showed on the
// first screen. At a short height the chrome folds up: the Activity control
// and Refresh join the status row, search and the quick filters share a line,
// and the sticky Activity bar scrolls away with the rest.
// https://github.com/alrayyes/forge-dashboard/issues/3406
//
// Pull requests and issues stand for every board: Releases and Bots render the
// same #pr-rows list under the same chrome, and the short-height rules in
// style.css are not keyed to a page (#3499).

const LANDSCAPE = [
  { width: 844, height: 390 },
  { width: 667, height: 375 },
] as const;

const PAGES = [
  { path: '/pull-requests.html', rows: '#pr-rows > .row' },
  { path: '/issues.html', rows: '#issue-rows > .row' },
] as const;

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
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

// One pull request with auto-merge on and one with it off, so the Auto-merge
// segment is offered and the bar keeps the controls these heights measure
// (#3669 hides a segment with one choice).
const PULLS = [
  makePR(1, { autoMergeEnabled: true }),
  makePR(2, { ci: 'failure', autoMergeEnabled: false }),
  makePR(3, { kind: 'release', title: 'chore(main): release 1.0.0' }),
  makePR(4, { kind: 'release', title: 'chore(main): release 1.1.0' }),
  makePR(5, { kind: 'dependency', title: 'Bump left-pad from 1.0.0 to 1.0.1' }),
  makePR(6, {
    kind: 'dependency',
    title: 'Bump right-pad from 1.0.0 to 1.0.1',
  }),
];

const ISSUES = [1, 2, 3].map((n) => ({
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: n,
  title: `Issue ${n}`,
  url: `https://example.com/issues/${n}`,
  author: 'ryan',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date(Date.now() - n * 1000).toISOString(),
}));

async function open(
  page: Page,
  path: string,
  size: { width: number; height: number },
) {
  await page.setViewportSize(size);
  const answer = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: PULLS,
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        navCounts: navCountsFor(PULLS, ISSUES.length),
        repos: [],
        hiddenDrafts: 0,
      }),
    });
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/v1/dashboard*', answer);
  await page.goto(path);
}

async function firstRow(page: Page, rows: string) {
  const row = page.locator(rows).first();
  await expect(row).toBeVisible();
  return row;
}

// The row's title and its status cell, bottom edges relative to the viewport.
async function rowBottoms(page: Page, rows: string) {
  const row = await firstRow(page, rows);
  return row.evaluate((el) => {
    const bottom = (node: Element | null) =>
      node ? node.getBoundingClientRect().bottom : Number.POSITIVE_INFINITY;
    const title = el.querySelector('.title');
    const status = el.querySelector('.status-cell > :first-child');
    return {
      row: el.getBoundingClientRect().bottom,
      title: bottom(title),
      status: status ? bottom(status) : bottom(title),
    };
  });
}

for (const size of LANDSCAPE) {
  for (const { path, rows } of PAGES) {
    test.describe(`${path} at ${size.width}x${size.height} (#3406)`, () => {
      test('a list row is on the first screen', async ({ page }) => {
        await open(page, path, size);
        // Retries until the row is laid out inside the first screen. A row
        // with no height, or a bottom of zero, never passes.
        await expect
          .poll(async () => {
            const b = await rowBottoms(page, rows);
            const inside = (v: number) => v > 0 && v <= size.height;
            return size.width === 844
              ? inside(b.row)
              : inside(b.title) && inside(b.status);
          })
          .toBe(true);
      });

      test('nothing scrolls sideways and every filter control is reachable', async ({
        page,
      }) => {
        await open(page, path, size);
        await firstRow(page, rows);
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.documentElement.clientWidth > 0 &&
                document.documentElement.scrollWidth -
                  document.documentElement.clientWidth <=
                  0,
            ),
          )
          .toBe(true);

        const search = page.getByRole('combobox', { name: 'Filter by title' });
        await expect(search).toBeVisible();
        if (size.width <= 760) {
          // The rest of the controls live in the Filters sheet.
          const trigger = page.getByRole('button', { name: /^Filters/ });
          await expect(trigger).toBeVisible();
          await trigger.click();
          await expect(page.locator('dialog#filter-sheet')).toBeVisible();
          await page.keyboard.press('Escape');
        } else if (path !== '/issues.html') {
          await expect(
            page.locator('.quick-pills').getByRole('button', { name: 'All' }),
          ).toBeVisible();
        }
      });

      test('Refresh stays reachable and 44px on a phone-sized touch target', async ({
        page,
      }) => {
        await open(page, path, size);
        await firstRow(page, rows);
        const tall = size.width <= 760 ? 44 : 24;
        for (const sel of ['#force-refresh-button']) {
          await expect
            .poll(
              async () => {
                const box = await page.locator(sel).boundingBox();
                return box !== null && box.height >= tall;
              },
              { message: sel },
            )
            .toBe(true);
        }
        if (size.width <= 760) {
          await expect
            .poll(async () => {
              const trigger = await page
                .getByRole('button', { name: /^Filters/ })
                .boundingBox();
              return trigger !== null && trigger.height >= 44;
            })
            .toBe(true);
        }
      });

      test(`axe finds nothing in light and dark`, async ({ page }) => {
        for (const scheme of ['light', 'dark'] as const) {
          await test.step(`${scheme}`, async () => {
            await open(page, path, size);

            await setTheme(page, scheme);

            await firstRow(page, rows);

            const results = await new AxeBuilder({ page })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
              .analyze();

            expect(results.violations).toEqual([]);
          });
        }
      });
    });
  }
}

// Portrait phones and desktop windows keep the layout they had: the same
// sticky Activity bar and the same chrome heights, measured at a few sizes.
// Heights are those of main before #3406.
const UNCHANGED = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1280, height: 800 },
] as const;

for (const size of UNCHANGED) {
  test(`pull requests at ${size.width}x${size.height} keep their layout (#3406)`, async ({
    page,
  }) => {
    await open(page, '/pull-requests.html', size);
    await firstRow(page, '#pr-rows > .row');
    await page.waitForLoadState('networkidle');
    await settle(page);
    const measure = () =>
      page.evaluate(() => {
        const h = (s: string) =>
          Math.round(
            document.querySelector(s)?.getBoundingClientRect().height ?? -1,
          );
        return {
          activityPosition: getComputedStyle(
            document.querySelector('.activity-bar') as Element,
          ).position,
          header: h('header'),
          toolbar: h('.dashboard-toolbar'),
          filterBar: h('.filter-bar'),
          updatesBar: h('.updates-bar'),
        };
      });
    await expect.poll(measure).toMatchObject({ activityPosition: 'sticky' });
    await expect
      .poll(measure)
      .toEqual(EXPECTED[`${size.width}x${size.height}`]);
  });
}

const EXPECTED: Record<
  string,
  {
    activityPosition: string;
    header: number;
    toolbar: number;
    filterBar: number;
    updatesBar: number;
  }
> = {
  '390x844': {
    activityPosition: 'sticky',
    header: 84,
    toolbar: 113,
    filterBar: 120,
    updatesBar: 58,
  },
  // The header is one row here, not two: Releases and Bots draw 2 passing
  // without a repeated total (#3489), so the nav pills fit beside the brand.
  '820x1180': {
    activityPosition: 'sticky',
    header: 82,
    toolbar: 54,
    filterBar: 135,
    updatesBar: 41,
  },
  '1280x800': {
    activityPosition: 'sticky',
    header: 82,
    toolbar: 54,
    filterBar: 96,
    updatesBar: 41,
  },
};
