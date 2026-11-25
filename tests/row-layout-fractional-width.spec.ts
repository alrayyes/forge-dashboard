import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/4779 and #4838
//
// A pair of queries written max-width: 760px and min-width: 761px leaves a
// gap: a list 760.5px wide matches neither and gets the bare row, with no
// phone card and no desktop rules. Every such pair now uses the range syntax
// (width <= 760px, width > 760px), which leaves no gap.

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

// A viewport can't be fractional, and an iframe is snapped to whole pixels,
// but a zoomed iframe is not: with zoom: 2 its inner width is the CSS width,
// fractions kept, and its media queries are
// evaluated against its own width.
async function probe(page: Page, width: number) {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto('/bots.html');
  await page.evaluate((w) => {
    document.body.innerHTML = '';
    const f = document.createElement('iframe');
    f.id = 'probe';
    f.src = '/bots.html';
    f.style.cssText = `zoom:2;width:${w}px;height:800px;border:0`;
    document.body.appendChild(f);
  }, width);
  const row = page.frameLocator('#probe').locator('#pr-rows > .row').first();
  await expect(row).toBeVisible();
  return row;
}

// The row's own layout, plus one thing only the desktop side sets. The bare
// row reads like the desktop row in the properties the grid places with, so
// this is what tells a width that fell through from one that matched.
async function rowLayout(page: Page, width: number) {
  const row = await probe(page, width);
  return row.evaluate((r) => {
    // .pipeline-run-button is centred in the base rules and starts its
    // content only above 760px.
    const button = document.createElement('a');
    button.className = 'pipeline-run-button';
    r.ownerDocument.body.appendChild(button);
    const buttonJustify = getComputedStyle(button).justifyContent;
    button.remove();
    const tree = [r, ...Array.from(r.querySelectorAll('*'))]
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
      .join('|');
    return { tree, buttonJustify };
  });
}

test.describe('One width switches the row layout (#4779, #4838)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
    await mockDashboard(page);
  });

  test('760.5px takes the desktop row, as 761px does, not the bare row', async ({
    page,
  }) => {
    const phone = await rowLayout(page, 760);
    const desktop = await rowLayout(page, 761);
    expect(phone).not.toEqual(desktop);
    expect(phone.buttonJustify).toBe('center');
    expect(desktop.buttonJustify).not.toBe('center');
    // Above 760px, so the desktop side. The bare row would read 'center'.
    expect(await rowLayout(page, 760.5)).toEqual(desktop);
  });

  // The 761-860px range ends at 860px and the wider rules begin there, not
  // one pixel later. Only the wider rules set --wide-status on a row.
  test('860.5px takes the rules above 860px, not the bare row', async ({
    page,
  }) => {
    const wide = async (w: number) => {
      const row = await probe(page, w);
      return row.evaluate((r) =>
        getComputedStyle(r).getPropertyValue('--wide-status').trim(),
      );
    };
    expect(await wide(860)).toBe('');
    expect(await wide(861)).not.toBe('');
    expect(await wide(860.5)).not.toBe('');
  });

  // A pair is a max-width: N and a min-width: N+1. A width between the two
  // matches neither, so none may be left, at any N.
  test('no max-width: Npx is paired with a min-width: N+1px', async ({
    page,
  }) => {
    await page.goto('/bots.html');
    const gaps = await page.evaluate(() => {
      const conditions: string[] = [];
      const walk = (rules: CSSRuleList) => {
        for (const r of Array.from(rules)) {
          if (r instanceof CSSMediaRule) conditions.push(r.conditionText);
          if (r instanceof CSSContainerRule) conditions.push(r.conditionText);
          if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules);
        }
      };
      for (const s of Array.from(document.styleSheets)) walk(s.cssRules);
      const num = (re: RegExp) =>
        conditions.flatMap((c) =>
          Array.from(c.matchAll(re), (m) => Number(m[1])),
        );
      const maxes = new Set(num(/(?:max-width:|width <=)\s*([\d.]+)px/g));
      return num(/(?:min-width:|width >=)\s*([\d.]+)px/g)
        .filter((n) => maxes.has(n - 1))
        .map((n) => `max-width: ${n - 1}px / min-width: ${n}px`);
    });
    expect(gaps).toEqual([]);
  });
});
