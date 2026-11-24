import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/4789
//
// A Dependabot row's label chips rendered one letter per line, so each chip
// was a tall thin strip and the row stretched to fit it. The row is an
// out-of-date Dependabot pull request whose CI is running, with comments and a
// waiting Auto-merge chip: the status cell then holds the CI pill, the chip,
// the comment pill and the buttons, which took the title track's width, and
// the chip's text broke at every letter in what was left. Larger text makes
// every rem track wider, so the same row is drawn at each width and text size.

const LABELS = [
  { name: 'dependencies', color: 'ededed' },
  { name: 'javascript', color: 'ededed' },
  { name: 'python', color: 'ededed' },
];

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
    labels: LABELS,
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

test.describe('Label chips stay on one line (#4789)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  });

  // Text size is the root font size, and the tracks are in rem, so each one
  // grows with it. It is set before the page's first layout, as a browser's
  // own text size is.
  const WIDTHS = [1280, 1360, 1424, 1500, 1700, 1918, 2560];
  const TEXTS = [100, 150, 175, 200];
  const cases: { scheme: 'light' | 'dark'; width: number; text: number }[] = [
    { scheme: 'light', width: 390, text: 100 },
    { scheme: 'dark', width: 1000, text: 150 },
    { scheme: 'dark', width: 1000, text: 200 },
    ...WIDTHS.flatMap((width) =>
      TEXTS.map((text) => ({
        scheme: (width % 2 ? 'light' : 'dark') as 'light' | 'dark',
        width,
        text,
      })),
    ),
  ];

  for (const { scheme, width, text } of cases) {
    test(`a Dependabot row's chips stay on a line, ${scheme}, ${width}px, ${text}% text`, async ({
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
      await expect(row.locator('.label-chip')).toHaveCount(3);

      const scale = text / 100;
      const measure = () =>
        row.evaluate((r) => ({
          root: getComputedStyle(document.documentElement).fontSize,
          row: r.getBoundingClientRect().height,
          title: r.querySelector('.title-cell')!.getBoundingClientRect().width,
          chips: Array.from(r.querySelectorAll('.label-chip')).map((c) => {
            const b = c.getBoundingClientRect();
            return { h: b.height, w: b.width };
          }),
        }));
      const m = await measure();
      // One 10.5px text line plus 1px padding and a 1px border either side
      // is about 18px; two lines is the most a chip may take.
      for (const c of m.chips) expect(c.h).toBeLessThanOrEqual(40 * scale);
      // A chip is as wide as its word, so the title track leaves room for it.
      for (const c of m.chips) expect(c.w).toBeGreaterThanOrEqual(40);
      expect(m.title).toBeGreaterThanOrEqual(
        Math.max(...m.chips.map((c) => c.w)),
      );
      expect(m.title).toBeGreaterThanOrEqual(120);
      // A few lines taller than a plain row, not a tower of letters.
      expect(m.row).toBeLessThanOrEqual(width < 800 ? 420 : 300 * scale);

      const results = await new AxeBuilder({ page })
        .withRules(['color-contrast', 'target-size'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
