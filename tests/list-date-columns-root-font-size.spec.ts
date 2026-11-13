import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3829
//
// The Created and Updated columns on the Issues and Pull requests lists sat in
// tracks sized in px while their text follows the root font size, so at 200%
// the two columns' text ran into each other at 1280px.

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
            title: 'Keep the date columns apart',
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
            title: 'Keep the date columns apart',
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

type Rect = { left: number; right: number; top: number; bottom: number };

// The painted extent of a cell: its box and everything its text draws, so text
// spilling out of a too-narrow track counts.
async function extents(page: Page, rows: string) {
  return page.evaluate((sel) => {
    const row = document.querySelector(`${sel} > .row`) as HTMLElement;
    const extent = (cls: string) => {
      const cell = row.querySelector(cls) as HTMLElement;
      const box = cell.getBoundingClientRect();
      let left = box.left;
      let right = box.right;
      let top = box.top;
      let bottom = box.bottom;
      const range = document.createRange();
      range.selectNodeContents(cell);
      for (const r of Array.from(range.getClientRects())) {
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
      return { left, right, top, bottom };
    };
    return {
      created: extent('.created'),
      updated: extent('.updated'),
      boxes: ['.created', '.updated'].map((c) => {
        const r = (row.querySelector(c) as HTMLElement).getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      }),
    };
  }, rows);
}

const intersects = (a: Rect, b: Rect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const LISTS = [
  ['Issues', '/issues.html', '#issue-rows'],
  ['Pull requests', '/pull-requests.html', '#pr-rows'],
] as const;

async function open(page: Page, path: string, rows: string, percent: number) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeDashboard(page);
  await page.goto(path);
  await expect(page.locator(`${rows} > .row`).first()).toBeVisible();
  if (percent !== 100) {
    await page.addStyleTag({
      content: `html { font-size: ${percent}% !important; }`,
    });
  }
}

for (const [name, path, rows] of LISTS) {
  for (const percent of [200, 400]) {
    test(`${name}: Created and Updated stay apart at ${percent}% and 1280px`, async ({
      page,
    }) => {
      await open(page, path, rows, percent);
      await expect
        .poll(async () => {
          const e = await extents(page, rows);
          // The text spilling out of its track is what made the columns touch
          // (right edge == left edge), so a gap has to be left, not just no
          // overlap.
          return (
            intersects(e.created, e.updated) ||
            e.created.right > e.boxes[0].right + 0.5 ||
            e.updated.right > e.boxes[1].right + 0.5 ||
            e.updated.left - e.created.right < 4
          );
        })
        .toBe(false);
    });
  }

  test(`${name}: the date columns keep their width at 100%`, async ({
    page,
  }) => {
    await open(page, path, rows, 100);
    const e = await extents(page, rows);
    expect(e.boxes.map((b) => b.width)).toEqual([82, 82]);
  });

  for (const mode of ['light', 'dark', 'forced-colors'] as const) {
    test(`${name}: axe finds nothing at 200% in ${mode}`, async ({ page }) => {
      if (mode === 'forced-colors') {
        await page.emulateMedia({ forcedColors: 'active' });
      } else {
        await page.emulateMedia({ colorScheme: mode });
      }
      await open(page, path, rows, 200);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
