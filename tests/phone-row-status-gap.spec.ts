import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3834: on a phone a plain pull request row showed about 170px of blank
// space between the CI pill and the Merge button. The waiting chip's slot
// (#1229) is meant to take 52px of it; nothing else in the status cell may.
// The slot stays reserved so the chip can appear without moving the row.
const MAX_GAP = 16;

function pr(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number: 7,
    title: 'A pull request',
    url: 'https://example.com/pull/7',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    ...overrides,
  };
}

const WAITING = {
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
};

async function open(page: Page, pullRequest: unknown) {
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
        pullRequests: [pullRequest],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  const row = page.locator('#pr-rows > .row').first();
  await expect(row).toBeVisible();
  return row;
}

// Distance from the CI pill's bottom to the top of the action bar's divider,
// minus the slot the cell reserves on purpose.
const gapOf = (row: import('@playwright/test').Locator) =>
  row.evaluate((r) => {
    const ci = r.querySelector('.ci-slot')?.getBoundingClientRect();
    const bar = r.querySelector('.row-action-bar')?.getBoundingClientRect();
    const slot = r.querySelector('.wait-slot')?.getBoundingClientRect();
    if (!ci || !bar || !slot || ci.height <= 0 || bar.height <= 0) return null;
    return {
      total: bar.top - ci.bottom,
      slot: slot.height,
      slotTop: slot.top,
      barTop: bar.top,
      ciBottom: ci.bottom,
    };
  });

test.describe('phone row status gap (#3834)', () => {
  test('390px: pill to action bar is the slot plus at most 16px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const row = await open(page, pr());
    await expect
      .poll(
        async () => {
          const g = await gapOf(row);
          return g !== null && g.total - g.slot <= MAX_GAP;
        },
        { message: JSON.stringify(await gapOf(row)) },
      )
      .toBe(true);
  });

  for (const width of [320, 360, 390]) {
    test(`${width}px: the chip appearing does not move the row`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const row = await open(page, pr());
      // The slot is the same box with or without the chip, and the chip
      // sits inside it. Arming also adds the auto-merge attribute chip above,
      // which is its own line and not the waiting chip's doing.
      const slotOf = (r: import('@playwright/test').Locator) =>
        r.evaluate((e) => {
          const s = e.querySelector('.wait-slot')?.getBoundingClientRect();
          const c = e.querySelector('.wait-chip')?.getBoundingClientRect();
          return {
            height: s?.height,
            chipInside:
              c === undefined ||
              (s !== undefined &&
                c.top >= s.top - 0.5 &&
                c.bottom <= s.bottom + 0.5),
          };
        });
      await expect(row.locator('.wait-chip')).toHaveCount(0);
      const without = await slotOf(row);

      await page.unrouteAll();
      const armed = await open(page, pr(WAITING));
      await expect(armed.locator('.wait-chip')).toBeVisible();
      const withChip = await slotOf(armed);
      expect(withChip).toEqual({ height: without.height, chipInside: true });
    });
  }

  for (const width of [320, 360, 390, 1280]) {
    for (const mode of ['light', 'dark', 'forced-colors'] as const) {
      test(`${width}px ${mode}: no axe violations, nothing clipped, 44px hit areas on a phone`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia(
          mode === 'forced-colors'
            ? { forcedColors: 'active' }
            : { colorScheme: mode },
        );
        const row = await open(page, pr({ behind: true }));
        const results = await new AxeBuilder({ page })
          .include('#pr-rows')
          .analyze();
        expect(results.violations).toEqual([]);

        const boxes = await row.evaluate((r) => {
          const rowBox = r.getBoundingClientRect();
          return [...r.querySelectorAll('.status-cell button, .status-cell a')]
            .map((e) => {
              const b = e.getBoundingClientRect();
              return {
                name: e.className,
                w: b.width,
                h: b.height,
                inside:
                  b.left >= rowBox.left - 0.5 && b.right <= rowBox.right + 0.5,
              };
            })
            .filter((b) => b.h > 0);
        });
        expect(boxes.length).toBeGreaterThan(0);
        for (const b of boxes) {
          expect(b.inside, JSON.stringify(b)).toBe(true);
          if (width <= 390 && /row-action/.test(b.name)) {
            expect(b.h, JSON.stringify(b)).toBeGreaterThanOrEqual(44);
          }
        }
      });
    }
  }
});
