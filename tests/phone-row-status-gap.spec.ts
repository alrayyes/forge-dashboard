import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
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

const BEHIND = {
  behind: true,
  allowedActions: [{ action: 'merge' }, { action: 'update_branch' }],
};

function snapshot(pullRequest: unknown) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [forgeHealth('github')],
    pullRequests: [pullRequest],
    issues: [],
    repos: [],
    hiddenDrafts: 0,
  };
}

// The stream is kept so a test can push a second snapshot into the same row,
// as the server does, instead of loading the page twice.
async function open(page: Page, pullRequest: unknown) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __streams: EventSource[];
      EventSource: typeof EventSource;
    };
    w.__streams = [];
    const Real = w.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        w.__streams.push(this);
      }
    };
  });
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(pullRequest)),
    }),
  );
  await page.goto('/pull-requests.html');
  const row = page.locator('#pr-rows > .row').first();
  await expect(row).toBeVisible();
  return row;
}

async function push(page: Page, pullRequest: unknown) {
  await page.evaluate(
    (data) => {
      const w = window as unknown as { __streams: EventSource[] };
      for (const stream of w.__streams)
        stream.onmessage?.(new MessageEvent('message', { data }));
    },
    JSON.stringify(snapshot(pullRequest)),
  );
}

// Distance from the CI pill's bottom to the top of the action bar's divider,
// the slot the cell reserves on purpose, and where the slot ends.
const gapOf = (row: Locator) =>
  row.evaluate((r) => {
    const ci = r.querySelector('.ci-slot')?.getBoundingClientRect();
    const bar = r.querySelector('.row-action-bar')?.getBoundingClientRect();
    const slot = r.querySelector('.wait-slot')?.getBoundingClientRect();
    const chip = r.querySelector('.wait-chip')?.getBoundingClientRect();
    if (!ci || !slot || ci.height <= 0) return null;
    return {
      // The action bar gives way to the chip while auto-merge waits.
      total: bar ? bar.top - ci.bottom : null,
      slot: slot.height,
      chipInside:
        chip === undefined ||
        (chip.top >= slot.top - 0.5 && chip.bottom <= slot.bottom + 0.5),
    };
  });

async function settled(row: Locator) {
  let g = await gapOf(row);
  await expect
    .poll(async () => {
      g = await gapOf(row);
      return g !== null;
    })
    .toBe(true);
  return g!;
}

test.describe('phone row status gap (#3834)', () => {
  const shapes = {
    'a plain row': {},
    'a behind row with Update branch': BEHIND,
  } as const;

  for (const [name, extra] of Object.entries(shapes)) {
    for (const width of [360, 390]) {
      test(`${width}px, ${name}: pill to action bar is the slot plus at most ${MAX_GAP}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        const row = await open(page, pr(extra));
        if (name !== 'a plain row') {
          await expect(
            row.getByRole('button', { name: 'Update branch' }),
          ).toBeVisible();
        }
        const g = await settled(row);
        expect(g.total! - g.slot, JSON.stringify(g)).toBeLessThanOrEqual(
          MAX_GAP,
        );
      });
    }
  }

  for (const width of [320, 360, 390]) {
    test(`${width}px: the wait chip appearing in the same row sits inside its slot`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const row = await open(page, pr(BEHIND));
      await expect(row.locator('.wait-chip')).toHaveCount(0);

      await push(page, pr({ ...BEHIND, ...WAITING }));
      await expect(row.locator('.wait-chip')).toBeVisible();
      const after = await settled(row);

      expect(after.slot).toBeGreaterThan(0);
      expect(after.chipInside).toBe(true);
    });
  }

  // #4519: the slot's reserved room sat between the pill line and the divider,
  // so a card with no chip read as having a blank band above its action. The
  // room is still reserved, below the action, so the card does not move when
  // the chip arrives.
  const MAX_DIVIDER_GAP = 16;
  for (const width of [360, 390]) {
    test(`${width}px: with no wait chip the divider sits within ${MAX_DIVIDER_GAP}px of the pill line`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const row = await open(page, pr());
      await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
      await expect
        .poll(async () => {
          const g = await gapOf(row);
          return g?.total !== null && g !== null && g.total !== undefined
            ? g.total <= MAX_DIVIDER_GAP
            : false;
        })
        .toBe(true);
    });

    // The status cell, not the whole row: an armed auto-merge also adds an
    // attribute chip under the title, which is content, not reserved room.
    test(`${width}px: the status cell is no taller after the wait chip arrives`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const row = await open(page, pr(BEHIND));
      await expect(row.locator('.wait-chip')).toHaveCount(0);
      const height = () =>
        row.evaluate(
          (r) =>
            r.querySelector('.status-cell')!.getBoundingClientRect().height,
        );
      const before = await height();

      await push(page, pr({ ...BEHIND, ...WAITING }));
      await expect(row.locator('.wait-chip')).toBeVisible();
      expect(await height()).toBeLessThanOrEqual(before);
    });
  }

  // The empty-cluster rule must stay on a phone: on desktop the empty box is
  // part of the grid and the title column is sized around it.
  test('1104px: the title column is the width it was without the phone rule', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1104, height: 800 });
    const row = await open(page, pr());
    const read = () =>
      row.evaluate((r) => {
        const c = r.querySelector('.attr-cluster');
        const t = r.querySelector('.title, button.title, a.title');
        return {
          display: c ? getComputedStyle(c).display : null,
          clusterWidth: c?.getBoundingClientRect().width ?? null,
          titleWidth: t?.getBoundingClientRect().width ?? null,
        };
      });
    await expect
      .poll(async () => {
        const c = await read();
        const ok =
          c.display !== null &&
          c.display !== 'none' &&
          (c.clusterWidth ?? 0) > 0 &&
          (c.titleWidth ?? 0) > 0;
        // The measured values name what failed, as the old assertions did.
        return ok ? 'ok' : JSON.stringify(c);
      })
      .toBe('ok');
  });

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

        const boxes = () =>
          row.evaluate((r) => {
            const rowBox = r.getBoundingClientRect();
            return [
              ...r.querySelectorAll('.status-cell button, .status-cell a'),
            ]
              .map((e) => {
                const b = e.getBoundingClientRect();
                return {
                  name: e.className,
                  w: b.width,
                  h: b.height,
                  inside:
                    b.left >= rowBox.left - 0.5 &&
                    b.right <= rowBox.right + 0.5,
                };
              })
              .filter((b) => b.h > 0);
          });
        // Re-measured until the buttons sit inside the row and, on a phone,
        // are tall enough, so a row still settling does not fail it.
        await expect
          .poll(async () => {
            const found = await boxes();
            return {
              any: found.length > 0,
              misfits: found
                .filter(
                  (b) =>
                    !b.inside ||
                    (width <= 390 && /row-action/.test(b.name) && b.h < 44),
                )
                .map((b) => JSON.stringify(b)),
            };
          })
          .toEqual({ any: true, misfits: [] });
      });
    }
  }
});
