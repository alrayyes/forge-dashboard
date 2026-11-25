import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #3834: on a phone a plain pull request row showed about 170px of blank
// space between the CI pill and the Merge button. The waiting chip's slot
// (#1229) is meant to take 52px of it; nothing else in the status cell may.
// With no chip the slot takes no room at all (#4590): the card grows once,
// downwards, when the user's own tap makes a chip appear.
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
// `sibling` adds a second pull request below the first. With one behind row,
// Update all vanishes the moment it is queued and the toolbar shifts; a
// second behind row keeps that bar so the spec measures the card alone (#4532).
async function open(page: Page, pullRequest: unknown, sibling?: unknown) {
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
      body: JSON.stringify({
        ...snapshot(pullRequest),
        pullRequests: sibling ? [pullRequest, sibling] : [pullRequest],
      }),
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
// where the slot's room sits between the pill and the action. Nothing is
// reserved below the action (#4590).
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

  // #4590: a card with no chip is no taller than its content. The room the
  // slot used to reserve under the action (#4519) is gone.
  const MAX_DIVIDER_GAP = 16;
  for (const width of [320, 360, 390]) {
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

    test(`${width}px: no band under the action either, the cell ends within ${MAX_DIVIDER_GAP}px of it`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const row = await open(page, pr());
      await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
      await expect(row.locator('.wait-slot')).toBeHidden();
      await expect
        .poll(() =>
          row.evaluate((r) => {
            const cell = r.querySelector('.status-cell')!;
            const bar = r.querySelector('.row-action-bar')!;
            return (
              cell.getBoundingClientRect().bottom -
              bar.getBoundingClientRect().bottom
            );
          }),
        )
        .toBeLessThanOrEqual(MAX_DIVIDER_GAP);
    });

    // The user's own tap makes the chip appear. The card grows, downwards:
    // nothing above it moves and the page keeps its scroll position.
    test(`${width}px: a tap that shows a chip grows the card downwards only`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.route('**/api/v1/pull-requests/update-branch', (route) =>
        route.fulfill({ status: 202 }),
      );
      const row = await open(page, pr(BEHIND), pr({ ...BEHIND, number: 8 }));
      await page.evaluate(() => {
        document.body.style.minHeight = '4000px';
        window.scrollTo(0, 40);
      });
      // Offsets are read from the row's own top, so the check holds even if
      // something above the card moves. The Activity control no longer does
      // (#4591), and phone-activity-no-push.spec.ts pins that.
      const marks = () =>
        row.evaluate((r) => {
          const top = r.getBoundingClientRect().top;
          const at = (s: string) =>
            Math.round(r.querySelector(s)!.getBoundingClientRect().top - top);
          return {
            scrollY: Math.round(window.scrollY),
            title: at('.title-cell'),
            pill: at('.ci-slot'),
            height: Math.round(r.getBoundingClientRect().height),
          };
        });
      const before = await marks();

      await row.getByRole('button', { name: 'Update branch' }).click();
      await expect(row.locator('.wait-chip')).toBeVisible();
      // The page keeps its scroll position. Read once, as soon as the chip
      // shows: a shift that settles back later must still fail.
      expect((await marks()).scrollY).toBe(before.scrollY);
      // The offsets and height are read again until they settle. A read
      // straight after the tap has come back with the title and pill at 0
      // (CI, at 320, 360 and 390px), so a single read can't tell a late redraw from a shift.
      await expect
        .poll(async () => {
          const { scrollY, ...m } = await marks();
          return { ...m, grew: m.height >= before.height, height: 0 };
        })
        .toEqual({
          title: before.title,
          pill: before.pill,
          grew: true,
          height: 0,
        });
    });
  }

  test('reduced motion: the card changes size with no transition or animation', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/api/v1/pull-requests/update-branch', (route) =>
      route.fulfill({ status: 202 }),
    );
    const row = await open(page, pr(BEHIND));
    await row.getByRole('button', { name: 'Update branch' }).click();
    await expect(row.locator('.wait-chip')).toBeVisible();
    // The row is drawn again as the request lands; read it after that.
    await expect(row.getByRole('button', { name: 'Queued…' })).toHaveCount(0);
    const motion = await row.evaluate((r) =>
      ['.status-cell', '.wait-slot', '.wait-chip'].map((s) => {
        const cs = getComputedStyle(r.querySelector(s)!);
        return `${s} ${cs.transitionDuration} ${cs.animationName}`;
      }),
    );
    for (const m of motion) {
      expect(m, JSON.stringify(motion)).toMatch(/ 0s none$/);
    }
  });

  test('390px: the chip is announced once by the live region', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/v1/pull-requests/update-branch', (route) =>
      route.fulfill({ status: 202 }),
    );
    const row = await open(page, pr(BEHIND));
    // The live region is cleared after it speaks, so count what it was told.
    await page.evaluate(() => {
      const w = window as unknown as { __spoken: string[] };
      w.__spoken = [];
      new MutationObserver(() => {
        const t = document.getElementById('feedback-live')?.textContent ?? '';
        if (t.trim()) w.__spoken.push(t);
      }).observe(document.getElementById('feedback-live')!, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    await row.getByRole('button', { name: 'Update branch' }).click();
    await expect(row.locator('.wait-chip')).toBeVisible();
    // The server still holds the request, as it does until the branch moves.
    // A snapshot without it would end the wait and say "Branch updated.",
    // which is a second announcement for a different event.
    const held = pr({
      ...BEHIND,
      updateRequest: {
        phase: 'queued',
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    });
    await push(page, held);
    const spoken = () =>
      page.evaluate(
        () => (window as unknown as { __spoken: string[] }).__spoken,
      );
    // Wait for the sentence itself, not for the first one: a slow page can
    // coalesce what the region was told.
    await expect
      .poll(spoken)
      .toEqual(['alrayyes/app#7: Branch update requested.']);
    // Let the region's own delay pass, with the snapshot drawn again, so a
    // second announcement would have landed by now.
    await push(page, held);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 250)));
    expect(await spoken()).toEqual([
      'alrayyes/app#7: Branch update requested.',
    ]);
  });

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

// #4099 criterion 2: with a chip showing, the chip is the slot's content, so
// nothing is left between it and the divider but the status cell's 6px gap and
// the bar's 4px top margin (10px).
const QUEUED = {
  ...BEHIND,
  queued: {
    id: 'q1',
    action: 'update_branch',
    forge: 'github',
    fullName: 'alrayyes/app',
    number: 7,
    status: 'queued',
    runAt: new Date(Date.now() + 8 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  },
};

test.describe('phone row, wait chip to divider (#4099)', () => {
  const MAX_CHIP_TO_DIVIDER = 16;
  for (const width of [320, 360, 390]) {
    test(`${width}px: a queued chip sits within ${MAX_CHIP_TO_DIVIDER}px of the divider and fills its slot`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const row = await open(page, pr(QUEUED));
      await expect(row.locator('.wait-chip')).toBeVisible();
      await expect(row.locator('.row-action-bar')).toBeVisible();
      const m = await row.evaluate((r) => {
        const chip = r.querySelector('.wait-chip')!.getBoundingClientRect();
        const slot = r.querySelector('.wait-slot')!.getBoundingClientRect();
        const bar = r.querySelector('.row-action-bar')!.getBoundingClientRect();
        return {
          chipToDivider: bar.top - chip.bottom,
          slotMinusChip: slot.height - chip.height,
        };
      });
      expect(m.chipToDivider, JSON.stringify(m)).toBeLessThanOrEqual(
        MAX_CHIP_TO_DIVIDER,
      );
      expect(m.slotMinusChip, JSON.stringify(m)).toBeLessThanOrEqual(0.5);
    });
  }

  test('390px: an armed auto-merge chip leaves no band under it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const row = await open(page, pr({ ...BEHIND, ...WAITING, ci: 'pending' }));
    await expect(row.locator('.wait-chip')).toBeVisible();
    // No bar, so no divider under the chip.
    await expect(row.locator('.row-action-bar')).toHaveCount(0);
    const m = await row.evaluate((r) => {
      const chip = r.querySelector('.wait-chip')!.getBoundingClientRect();
      const cell = r.querySelector('.status-cell')!.getBoundingClientRect();
      return { below: cell.bottom - chip.bottom };
    });
    expect(m.below, JSON.stringify(m)).toBeLessThanOrEqual(MAX_CHIP_TO_DIVIDER);
  });
});
