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
// with its labels dropped.

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

test.describe('A no-label row keeps a readable title (#4795)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  });

  const WIDTHS = [320, 390, 768, 1280, 1918];
  const TEXTS = [100, 175];
  for (const width of WIDTHS) {
    for (const text of TEXTS) {
      for (const scheme of ['light', 'dark'] as const) {
        test(`the title is readable, ${scheme}, ${width}px, ${text}% text`, async ({
          page,
        }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await page.setViewportSize({ width, height: 1080 });
          await mockDashboard(page, [makePR(1)]);
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
          await expect(row.locator('.label-chip')).toHaveCount(0);
          await expect(row.locator('.wait-chip')).toBeVisible();

          const m = await row.evaluate((r) => {
            const t = r.querySelector('.title-cell')!.getBoundingClientRect();
            const a = r.querySelector('.title')!;
            return {
              cell: t.width,
              clipped: a.scrollWidth > a.clientWidth + 1,
              right: r.getBoundingClientRect().right,
              status: r.querySelector('.status-cell')!.getBoundingClientRect()
                .right,
            };
          });
          if (width >= 1280) expect(m.cell).toBeGreaterThanOrEqual(200);
          else expect(m.cell).toBeGreaterThanOrEqual(120);
          expect(m.status).toBeLessThanOrEqual(m.right + 1);

          const results = await new AxeBuilder({ page })
            .withRules(['color-contrast', 'target-size'])
            .analyze();
          expect(results.violations).toEqual([]);
        });
      }
    }
  }
});
