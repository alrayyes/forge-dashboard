import { expect, type Page, type Route } from '@playwright/test';
import { mainBranchPageOf } from './nav-counts-helper';
import { test } from './server-fixture';

// #1458: the Branches item shows the total and how many default branches are
// failing, running and passing, as the pull request items do (#1439). The
// page counts the rows of `mainBranchPage` (#2886) and draws the tally.
// The pill's own markup (glyphs, order, the approval count, a zero not drawn,
// no pill when empty) is asserted in the NavPills stories' play functions
// (#3626). What stays here needs the real bottom nav's layout.
// https://github.com/alrayyes/forge-dashboard/issues/1458

type Counts = {
  total: number;
  failed: number;
  running: number;
  passed: number;
  none: number;
  awaitingApproval?: number;
};

// One row per branch, so the page has exactly these counts to work out.
function rowsFor(c: Counts) {
  const n = (status: string, count = 0) => Array(count).fill(status);

  return mainBranchPageOf([
    ...n('failed', c.failed),
    ...n('running', c.running),
    ...n('passed', c.passed),
    ...n('none', c.none),
    ...n('awaiting_approval', c.awaitingApproval),
  ]);
}

const MIXED: Counts = { total: 7, failed: 2, running: 1, passed: 3, none: 1 };

async function open(page: Page, branches: Counts) {
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
        pullRequests: [],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
        mainBranchPage: rowsFor(branches),
        navCounts: {
          pullRequests: { total: 0, failed: 0, running: 0, passed: 0 },
          issues: { total: 0 },
          releases: { total: 0, failed: 0, running: 0, passed: 0 },
          bots: { total: 0, failed: 0, running: 0, passed: 0 },
        },
      }),
    }),
  );
  await page.goto('/settings.html');
}

const BRANCHES = '/';
const tab = (page: Page) => page.locator(`.bottom-nav a[href="${BRANCHES}"]`);

test.describe('the Branches nav pill shows failing, running and passing (#1458)', () => {
  test('on a 360px phone every tab fits and the pill stays inside its tab', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page, MIXED);
    await expect(tab(page).locator('.nav-pills')).toBeVisible();

    // Retry the measurement: a link read while hydration swaps the nav's
    // nodes has a 0x0 box, which is a moment, not a layout.
    await expect
      .poll(() =>
        page.locator('.bottom-nav .bottom-nav-link').evaluateAll(
          (els) =>
            els.length > 0 &&
            els.every((el) => {
              const r = el.getBoundingClientRect();
              const p = el.querySelector('.nav-pills')?.getBoundingClientRect();
              return (
                r.right <= 361 &&
                r.height >= 44 &&
                (!p || (p.left >= r.left - 1 && p.right <= r.right + 1))
              );
            }),
        ),
      )
      .toBe(true);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('with five counts of three digits the tab still fits at 360px (#1531)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page, {
      total: 500,
      failed: 111,
      running: 112,
      passed: 113,
      none: 164,
    });
    await expect(tab(page).locator('.nav-none')).toHaveText('164');
    await expect
      .poll(() =>
        page.locator('.bottom-nav .bottom-nav-link').evaluateAll(
          (els) =>
            els.length > 0 &&
            els.every((el) => {
              const r = el.getBoundingClientRect();
              const p = el.querySelector('.nav-pills')?.getBoundingClientRect();
              return (
                r.height > 0 &&
                r.right <= 361 &&
                (!p || (p.left >= r.left - 1 && p.right <= r.right + 1))
              );
            }),
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
  });
});
