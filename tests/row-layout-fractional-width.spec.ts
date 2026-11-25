import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/4779
//
// The phone rules ended at max-width: 760px and the desktop rules began at
// min-width: 761px, so a list 760.5px wide matched neither and got the
// bare row, with no phone card and no desktop grid. Both now use the range
// syntax (width <= 760px, width > 760px), which leaves no gap.

const PR = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 1,
  title: 'Bump package from 1.0.0 to 1.0.1',
  url: 'https://example.com/1',
  author: 'dependabot[bot]',
  draft: false,
  ci: 'success',
  labels: [{ name: 'dependencies', color: 'ededed' }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'clean',
  behind: false,
  status: { code: 'ready', message: 'Ready to merge' },
  reviewComments: 0,
  conversationComments: 0,
  unresolvedThreads: 0,
  checks: { passed: 3, running: 0, waiting: 0, failed: 0 },
  allowedActions: [{ action: 'merge', primary: true }, { action: 'close' }],
  kind: 'dependency',
};

function mockDashboard(page: Page) {
  return page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [PR],
        issues: [],
        openIssueCount: 0,
        navCounts: navCountsFor([PR], 0),
      }),
    }),
  );
}

// A viewport can't be fractional, but an iframe can: its media queries are
// evaluated against its own width.
async function rowLayout(page: Page, width: number) {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto('/bots.html');
  await page.evaluate((w) => {
    document.body.innerHTML = '';
    const f = document.createElement('iframe');
    f.id = 'probe';
    f.src = '/bots.html';
    f.style.cssText = `width:${w}px;height:800px;border:0`;
    document.body.appendChild(f);
  }, width);
  const row = page.frameLocator('#probe').locator('#pr-rows > .row').first();
  await expect(row).toBeVisible();
  // Every element in the row, by the properties the two layouts place with.
  return row.evaluate((r) =>
    [r, ...Array.from(r.querySelectorAll('*'))]
      .map((el) => {
        const cs = getComputedStyle(el);
        return [
          el.className,
          cs.display,
          cs.position,
          cs.gridColumnStart,
          cs.gridRowStart,
          cs.flexDirection,
        ].join('/');
      })
      .join('|'),
  );
}

test.describe('One width switches the row layout (#4779)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
    await mockDashboard(page);
  });

  test('760.5px takes the phone or the desktop row, never a third', async ({
    page,
  }) => {
    const phone = await rowLayout(page, 760);
    const desktop = await rowLayout(page, 761);
    expect(phone).not.toEqual(desktop);
    const between = await rowLayout(page, 760.5);
    expect([phone, desktop]).toContain(between);
  });

  // The desktop rules start where the phone rules end, not one pixel later:
  // width > 760px, so a width between the two cannot fall through.
  test('no media query starts at 761px', async ({ page }) => {
    await page.goto('/bots.html');
    const gaps = await page.evaluate(() => {
      const found: string[] = [];
      const walk = (rules: CSSRuleList) => {
        for (const r of Array.from(rules)) {
          if (r instanceof CSSMediaRule && /761px/.test(r.conditionText))
            found.push(r.conditionText);
          if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules);
        }
      };
      for (const s of Array.from(document.styleSheets)) walk(s.cssRules);
      return found;
    });
    expect(gaps).toEqual([]);
  });
});
