import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { mainBranchPageOf } from './nav-counts-helper';
import { test } from './server-fixture';

// #1458: the Branches item shows the total and how many default branches are
// failing, running and passing, as the pull request items do (#1439). The
// page counts the rows of `mainBranchPage` (#2886) and draws the tally.
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
const header = (page: Page) => page.locator(`header nav a[href="${BRANCHES}"]`);
const tab = (page: Page) => page.locator(`.bottom-nav a[href="${BRANCHES}"]`);

test.describe('the Branches nav pill shows failing, running and passing (#1458)', () => {
  test('shows the total, then failed, passed and running, each with its glyph', async ({
    page,
  }) => {
    await open(page, MIXED);
    const pill = header(page).locator('.nav-pills');

    await expect(pill).toHaveAttribute('aria-hidden', 'true');
    await expect(pill.locator('.nav-total')).toHaveText('7');
    await expect(pill.locator('.nav-failed')).toHaveText('2');
    await expect(pill.locator('.nav-running')).toHaveText('1');
    await expect(pill.locator('.nav-passed')).toHaveText('3');
    await expect(pill.locator('.nav-none')).toHaveText('1');
    for (const kind of ['failed', 'running', 'passed', 'none']) {
      await expect(pill.locator(`.nav-${kind} svg`).first()).toBeAttached();
    }
    // Outcomes, the divider, the state, then the branches with no pipeline,
    // which are neither (#1563).
    const order = await pill.evaluate((el) =>
      [...el.children].map(
        (c) => c.className.split(' ').find((n) => n !== 'nav-count') ?? '',
      ),
    );
    expect(order).toEqual([
      'nav-total',
      'nav-failed',
      'nav-passed',
      'nav-divider',
      'nav-running',
      'nav-none',
    ]);
  });

  test('a branch held for workflow approval is drawn, so the parts add up to the total (#2024)', async ({
    page,
  }) => {
    // 8 branches: 3 passed, 4 running, and one waiting for someone to approve
    // its workflow runs. The pill used to show 8 with 3 and 4 and nothing for
    // the eighth.
    await open(page, {
      total: 8,
      failed: 0,
      running: 4,
      passed: 3,
      none: 0,
      awaitingApproval: 1,
    });
    const pill = header(page).locator('.nav-pills');

    await expect(pill.locator('.nav-total')).toHaveText('8');
    await expect(pill.locator('.nav-passed')).toHaveText('3');
    await expect(pill.locator('.nav-running')).toHaveText('4');
    await expect(pill.locator('.nav-awaiting')).toHaveText('1');
    await expect(pill.locator('.nav-awaiting svg').first()).toBeAttached();
    const shown = await pill
      .locator('.nav-count')
      .evaluateAll((els) =>
        els.reduce((n, el) => n + Number(el.textContent?.trim()), 0),
      );
    expect(shown).toBe(8);
    // The link's own name says it in words as well as numbers.
    await expect(header(page)).toHaveAttribute(
      'aria-label',
      /1 waiting for approval/,
    );
  });

  test('a count of zero is not drawn, and no branches means no pill', async ({
    page,
  }) => {
    await open(page, { total: 5, failed: 0, running: 0, passed: 5, none: 0 });
    const pill = header(page).locator('.nav-pills');
    await expect(pill.locator('.nav-passed')).toHaveText('5');
    await expect(pill.locator('.nav-none')).toHaveCount(0);
    await expect(pill.locator('.nav-failed')).toHaveCount(0);
    await expect(pill.locator('.nav-running')).toHaveCount(0);

    await open(page, { total: 0, failed: 0, running: 0, passed: 0, none: 0 });
    await expect(header(page).locator('.nav-pills')).toHaveCount(0);
  });

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

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe-core violations in the ${scheme} theme, on desktop and on a phone`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, MIXED);

      for (const size of [
        { width: 1280, height: 800 },
        { width: 360, height: 740 },
      ]) {
        await page.setViewportSize(size);
        await expect(header(page).locator('.nav-pills')).toHaveCount(1);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      }
    });
  }
});
