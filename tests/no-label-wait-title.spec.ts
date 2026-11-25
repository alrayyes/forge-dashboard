import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/4795
//
// A row with a waiting chip, a comment pill and an action but no labels was
// drawn on one line at 1280px, and the status track took the whole row: the
// title track was 0px wide. The fixture is the one from label-chip-one-line
// with its labels dropped. The same row with an unarmed chip (Auto-merge
// button) left the title 70px, so both stack the chip on a line of its own.
// A row with labels already did, and is pinned here so it stays so.

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Bump package-${number} from 1.0.0 to 1.0.1`,
    url: `https://example.com/${number}`,
    author: 'dependabot[bot]',
    draft: false,
    ci: 'pending',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    checks: { passed: 12, running: 17, waiting: 1, failed: 0 },
    autoMergeEnabled: true,
    autoMergeHeldBy: 'dashboard',
    autoMerge: {
      state: 'waiting',
      code: 'checks_pending',
      message: 'Auto-merge is waiting for checks to finish.',
    },
    status: {
      code: 'checks_pending',
      message: 'Waiting for CI to finish',
      next: 'Merge unlocks automatically',
    },
    allowedActions: [
      {
        action: 'merge',
        blocked: {
          code: 'checks_pending',
          message: 'Waiting for CI to finish',
        },
      },
      { action: 'cancel_auto_merge' },
      { action: 'dependabot_rebase', primary: true },
      { action: 'close' },
    ],
    reviewComments: 4,
    conversationComments: 3,
    unresolvedThreads: 2,
    kind: 'dependency',
    ...overrides,
  };
}

const UNARMED = {
  autoMergeEnabled: false,
  autoMergeHeldBy: undefined,
  autoMerge: undefined,
  allowedActions: [
    {
      action: 'merge',
      blocked: { code: 'checks_pending', message: 'Waiting for CI to finish' },
    },
    { action: 'auto_merge' },
    { action: 'dependabot_rebase', primary: true },
    { action: 'close' },
  ],
};

const VARIANTS = [
  { name: 'an armed row', over: {} },
  { name: 'an unarmed row', over: UNARMED },
  {
    name: 'a row with labels',
    over: { labels: [{ name: 'dependencies', color: 'ededed' }] },
  },
];

function mockDashboard(page: Page, pullRequests: unknown[]) {
  return page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests,
        issues: [],
        openIssueCount: 0,
        navCounts: navCountsFor(pullRequests, 0),
      }),
    }),
  );
}

test.describe('A waiting row keeps a readable title (#4795)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  });

  // The title is the pull request's name and may end in an ellipsis. It is
  // readable when its cell keeps the room the ticket asks for: 200px at 1280px
  // and up. Narrower lists and the phone card were not in the bug, and keep
  // the title track they already had: 160px at 768px (the 240px repo and the
  // status cell take the rest), and the card's full width on a phone. Those
  // are pinned so the change does not narrow them.
  const floorAt = (width: number) => (width >= 1280 ? 200 : 160);
  const WIDTHS = [320, 390, 768, 1280, 1918];
  const TEXTS = [100, 175];
  for (const variant of VARIANTS) {
    for (const width of WIDTHS) {
      for (const text of TEXTS) {
        for (const scheme of ['light', 'dark'] as const) {
          test(`${variant.name}: the title is readable, ${scheme}, ${width}px, ${text}% text`, async ({
            page,
          }) => {
            await page.emulateMedia({ colorScheme: scheme });
            await page.setViewportSize({ width, height: 1080 });
            await mockDashboard(page, [makePR(1, variant.over)]);
            await page.addInitScript((c) => {
              const put = () => {
                if (!document.head) return false;
                const el = document.createElement('style');
                el.textContent = c;
                document.head.appendChild(el);
                return true;
              };
              if (put()) return;
              const watch = new MutationObserver(() => {
                if (put()) watch.disconnect();
              });
              watch.observe(document, { childList: true, subtree: true });
            }, `html { font-size: ${text}% !important; }`);
            await page.goto('/bots.html');
            const row = page.locator('#pr-rows > .row').first();
            await expect(row).toBeVisible();
            await expect(row.locator('.wait-chip')).toBeVisible();

            const m = await row.evaluate((r) => {
              const box = (sel: string) =>
                r.querySelector(sel)!.getBoundingClientRect();
              return {
                title: box('.title-cell').width,
                chipTop: box('.wait-chip').top,
                flagsBottom: box('.status-flags').bottom,
                status: box('.status-cell').right,
                right: r.getBoundingClientRect().right,
              };
            });
            expect(m.title).toBeGreaterThanOrEqual(floorAt(width));
            expect(m.status).toBeLessThanOrEqual(m.right + 1);
            // From 1280px the chip is on a line of its own, under the pills,
            // with or without labels, until the list is 94rem wide (1504px at
            // the default 16px text, 94rem * text / 100 at larger sizes). From
            // there the chip sits beside the pills (#4784). The list is
            // narrower than the viewport, so only 1918px at 100% text is
            // asserted to be past the threshold.
            const wide = width >= (1504 * text) / 100;
            if (width >= 1280 && !wide)
              expect(m.chipTop).toBeGreaterThanOrEqual(m.flagsBottom - 1);
            if (wide) expect(m.chipTop).toBeLessThan(m.flagsBottom);

            const results = await new AxeBuilder({ page })
              .withRules(['color-contrast', 'target-size'])
              .analyze();
            expect(results.violations).toEqual([]);
          });
        }
      }
    }
  }
});
