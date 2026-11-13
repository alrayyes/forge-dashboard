import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Out of date chip keeps its icon and words on one line and inside its own
// box, beside an Auto-merge chip and a running CI pill. Mocks
// /api/v1/dashboard only.
// https://github.com/alrayyes/forge-dashboard/issues/3250
//
// Before the fix the chip's own flex-wrap let its icon and words stack once the
// attribute cluster was narrower than both, which it is from the desktop
// layout (780px) upward when the CI pill carries counts, so the words ran past
// the box. The phone layout (390px) was never affected.

const BOT = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 7,
  title: 'Bump package from 1.0.0 to 1.0.1',
  url: 'https://example.com/7',
  author: 'dependabot[bot]',
  draft: false,
  ci: 'pending',
  checks: { passed: 6, running: 5, waiting: 9, failed: 11 },
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'blocked',
  behind: true,
  autoMergeEnabled: true,
  kind: 'dependency',
};

const REGULAR = {
  ...BOT,
  title: 'Add the thing',
  author: 'claude',
  kind: 'regular',
  // A live Update branch takes the chip's place on a row (#3770), so this one
  // has none and still draws it.
  allowedActions: [{ action: 'close' }],
  status: null,
};

async function open(
  page: Page,
  path: string,
  width: number,
  scheme: 'light' | 'dark',
) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 800 });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [path === '/bots.html' ? BOT : REGULAR],
        issues: [],
        openIssueCount: 0,
      }),
    }),
  );
  await page.goto(path);
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
}

for (const path of ['/bots.html', '/pull-requests.html']) {
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [390, 820, 1280, 1935]) {
      test(`Out of date chip fits its box on ${path} at ${width}px, ${scheme} (#3250)`, async ({
        page,
      }) => {
        await open(page, path, width, scheme);
        const chip = page.locator('#pr-rows .attr-chip.behind');
        await expect(chip).toBeVisible();
        await expect(chip).toHaveText(/Out of date/);

        // Re-measured until every check holds, so a layout still settling on a
        // loaded runner doesn't fail the test. A chip with no box, or no text
        // rectangles, never passes.
        await expect
          .poll(() =>
            chip.evaluate((el) => {
              const box = el.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(el);
              const kids = Array.from(range.getClientRects());
              if (box.width <= 0 || box.height <= 0 || kids.length === 0)
                return false;
              return (
                el.scrollWidth <= el.clientWidth &&
                Math.max(...kids.map((r) => r.right)) <= box.right + 0.5 &&
                Math.max(...kids.map((r) => r.bottom)) <= box.bottom + 0.5 &&
                Math.min(...kids.map((r) => r.top)) >= box.top - 0.5
              );
            }),
          )
          .toBe(true);
      });
    }
  }
}
