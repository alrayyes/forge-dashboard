import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// #3264: on a phone the waiting chip's reserved slot (#1229) sat between the
// meta line and the status pill, so every Bots and Releases row read as having
// about 90px of blank space above the pill. The slot is still reserved, but
// below the pill. The gap to measure is meta line to pill.
const MAX_GAP = 16;

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

const BOT_PR = makePR(20, {
  title: 'Bump package-20 from 1.0.0 to 1.0.1',
  author: 'dependabot',
  kind: 'dependency',
});

// The same row with auto-merge armed: the waiting chip and its Disarm button
// are in the reserved slot.
const ARMED_PR = makePR(21, {
  title: 'Bump package-21 from 1.0.0 to 1.0.1',
  author: 'dependabot',
  kind: 'dependency',
  forge: 'forgejo',
  repo: 'alrayyes/dotfiles',
  ci: 'pending',
  mergeStatus: 'blocked',
  autoMergeEnabled: true,
  autoMerge: {
    state: 'waiting',
    code: 'checks_pending',
    message: 'Auto-merge is waiting for checks to finish.',
  },
  allowedActions: [
    { action: 'merge' },
    { action: 'close' },
    { action: 'cancel_auto_merge' },
  ],
});

function mockDashboard(page: Page, pullRequests: unknown[]) {
  return page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
        openIssueCount: 0,
        navCounts: navCountsFor(pullRequests, 0),
      }),
    }),
  );
}

test.describe('phone rows keep the pill close to the meta line (#3264)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test(`at most ${MAX_GAP}px from meta to pill, slot still reserved below`, async ({
    page,
  }) => {
    await mockDashboard(page, [BOT_PR]);
    await page.goto('/bots.html');
    const row = page.locator('#pr-rows > .row').first();
    await expect(row).toBeVisible();

    // Re-measured until every check holds, so a layout still settling on a
    // loaded runner doesn't fail the test. An unrendered box can't pass.
    await expect
      .poll(() =>
        row.evaluate((r, maxGap) => {
          const box = (s: string) =>
            r.querySelector(s)?.getBoundingClientRect();
          const metaBottom = Math.max(
            ...['.author', '.created', '.updated'].map(
              (s) => box(s)?.bottom ?? 0,
            ),
          );
          const ci = box('.ci-slot');
          const slot = box('.wait-slot');
          if (!ci || !slot || ci.height <= 0 || metaBottom <= 0) return false;
          return (
            ci.top - metaBottom <= maxGap &&
            slot.height >= 44 &&
            slot.top >= ci.bottom
          );
        }, MAX_GAP),
      )
      .toBe(true);
  });

  // WCAG 2.4.3 and 1.3.2: the slot sits below the pill on screen, so it
  // comes after the pill in the document too. Focus must only ever move down.
  test('Tab walks an armed row top to bottom: title, pill, chip, Disarm', async ({
    page,
  }) => {
    await mockDashboard(page, [ARMED_PR]);
    await page.goto('/bots.html');
    const row = page.locator('#pr-rows > .row').first();
    await expect(row.locator('.wait-chip')).toBeVisible();

    await row.locator('.title-cell .title').first().focus();
    const stops: { name: string; y: number; inSlot: boolean; inCi: boolean }[] =
      [];
    for (let i = 0; i < 12; i++) {
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const r = el.closest('#pr-rows > .row');
        if (!r) return null;
        return {
          name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
          y: Math.round(el.getBoundingClientRect().top),
          inSlot: el.closest('.wait-slot') !== null,
          inCi: el.closest('.ci-slot') !== null,
        };
      });
      if (!stop) break;
      stops.push(stop);
      await page.keyboard.press('Tab');
    }
    const ys = stops.map((s) => s.y);
    expect(ys, JSON.stringify(stops)).toEqual([...ys].sort((a, b) => a - b));
    const ci = stops.findIndex((s) => s.inCi);
    const chip = stops.findIndex((s) => s.inSlot);
    expect(ci, 'the CI pill is a tab stop').toBeGreaterThanOrEqual(0);
    expect(chip, 'the chip is a tab stop').toBeGreaterThanOrEqual(0);
    expect(ci).toBeLessThan(chip);
  });
});

// #3264 acceptance: only the phone layout changes. At 820px and wider the
// reserved slot stays above the pill, where main has always drawn it. These
// offsets from the row's top edge were measured on main before the fix.
test.describe('wider rows keep the wait slot above the pill (#3264)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  });

  // Offsets from the row's top edge, compared as booleans (never rounded, so
  // there is no -0). A missing or unrendered element reads as false.
  const atOffsets = (
    row: import('@playwright/test').Locator,
    want: Record<string, number>,
  ) =>
    expect
      .poll(() =>
        row.evaluate((r, want) => {
          const rowBox = r.getBoundingClientRect();
          if (rowBox.height <= 0) return false;
          return Object.entries(want).every(([sel, offset]) => {
            const b = r.querySelector(sel)?.getBoundingClientRect();
            return (
              b !== undefined &&
              b !== null &&
              b.height > 0 &&
              Math.abs(b.top - rowBox.top - offset) < 0.5
            );
          });
        }, want),
      )
      .toBe(true);

  for (const width of [820, 1280]) {
    test(`${width}px: plain row has the slot at 12 and the pill at 62`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockDashboard(page, [BOT_PR]);
      await page.goto('/bots.html');
      const row = page.locator('#pr-rows > .row').first();
      await expect(row).toBeVisible();
      await atOffsets(row, { '.wait-slot': 12, '.ci-slot': 62 });
    });

    test(`${width}px: armed row has the slot at 12, the pill at 62, the status line at 92`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockDashboard(page, [ARMED_PR]);
      await page.goto('/bots.html');
      const row = page.locator('#pr-rows > .row').first();
      await expect(row.locator('.wait-chip')).toBeVisible();
      await atOffsets(row, {
        '.wait-slot': 12,
        '.ci-slot': 62,
        '.status-area': 92,
      });
    });
  }
});
