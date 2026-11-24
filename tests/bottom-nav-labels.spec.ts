import { expect, type Page } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { mainBranchPageFor } from './nav-counts-helper';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3288
//
// With all the tabs showing, the bottom nav's labels collided at 320px
// (the WCAG 1.4.10 Reflow width): a long label overflowed its 40px tab and
// touched its neighbour, and Branches began off-screen. Every label
// must sit inside the viewport and inside its own tab, with at least 2px
// between neighbours.

// 318 to 324 straddle the width where tabs start keeping 44px (BREAKPOINT).
const WIDTHS = [320, 321, 322, 323, 324, 340, 360, 375, 390, 412];
// Seven tabs, PRs and Bots held to 44px and the rest sized by their word, need
// 319px of bar (measured in the real bar); 322px rounds that up.
const BREAKPOINT = 322;

// The numbers drawn above the icons (#1315) must not widen a tab either.
const MIXED = {
  branches: { total: 12, failed: 3 },
  pullRequests: { total: 27, failed: 5 },
  issues: { total: 9 },
  releases: { total: 2, failed: 0 },
  bots: { total: 14, failed: 1 },
};

async function withCounts(page: Page) {
  const { branches, ...navCounts } = MIXED;
  const answer = (route: import('@playwright/test').Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [],
        issues: [],
        navCounts,
        mainBranchPage: mainBranchPageFor(branches.total, branches.failed),
      }),
    });
  await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
  await page.route('**/api/v1/dashboard*', answer);
}

test.describe('bottom nav labels (#3288)', () => {
  test('labels are separate and inside their tabs at every width', async ({
    page,
  }) => {
    // Every tab is drawn only for a known count above zero (#4276), so the
    // seven-tab bar needs counts, and each tab then draws its pill.
    await withCounts(page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/insights.html');
      await expect(page.locator('.bottom-nav-label')).toHaveCount(7);
      // Widths are those of the web font, not the fallback it replaces.
      await page.evaluate(() => document.fonts.ready);
      // Branches, PRs, Releases, Bots and Issues each draw a pill.
      await expect(page.locator('.bottom-nav .nav-pills')).toHaveCount(5);

      // Retries until the bar has settled; a missing or empty label or tab
      // is itself a problem, so an unrendered bar never passes.
      const measure = async () => {
        const boxes = await page.$$eval('.bottom-nav-link', (links) =>
          links.map((link) => {
            const label = link.querySelector('.bottom-nav-label');
            const l = label?.getBoundingClientRect();
            const t = link.getBoundingClientRect();
            return {
              name: label?.textContent?.trim() ?? '',
              laidOut: !!l && l.width > 0 && t.width > 0,
              left: l?.left ?? 0,
              right: l?.right ?? 0,
              tabLeft: t.left,
              tabRight: t.right,
            };
          }),
        );

        const problems: string[] = [];
        if (boxes.length !== 7)
          problems.push(`${boxes.length} tabs, expected 7`);
        // Tabs are at least 44px wide where seven fit and 32px below that.
        const minTab = width >= BREAKPOINT ? 44 : 32;
        for (const b of boxes) {
          if (!b.laidOut) problems.push(`${b.name} is not laid out`);
          if (b.tabRight - b.tabLeft < minTab - 0.01)
            problems.push(
              `${b.name} tab is ${(b.tabRight - b.tabLeft).toFixed(1)}px, under ${minTab}px`,
            );
        }
        for (const [i, b] of boxes.entries()) {
          if (b.left < 0 || b.right > width)
            problems.push(
              `${b.name} leaves the viewport (${b.left}-${b.right})`,
            );
          if (b.left < b.tabLeft - 0.01 || b.right > b.tabRight + 0.01)
            problems.push(
              `${b.name} ${b.left.toFixed(1)}-${b.right.toFixed(1)} overflows its tab ${b.tabLeft.toFixed(1)}-${b.tabRight.toFixed(1)}`,
            );
          const next = boxes[i + 1];
          if (next && next.left - b.right < 2)
            problems.push(
              `${b.name}/${next.name} gap ${(next.left - b.right).toFixed(1)}px`,
            );
        }
        return problems;
      };
      await expect
        .configure({ soft: true })
        .poll(measure, { message: `${width}px` })
        .toEqual([]);
    }
  });
});
