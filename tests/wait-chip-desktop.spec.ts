import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #4596: on a desktop the waiting chip is a compact status, not a banner. It
// is as wide as its words and its button, 30px tall, and sits on the status
// pill's line where it fits. A row that has one is no taller than a row that
// has none by more than the chip's own line, and the title keeps (or gains)
// its width. The phone card keeps its 59px slot (#4590, #4593).

type MockPR = Record<string, unknown>;

// What the list drew before this change, measured on the same pull request
// at each window width: the title cell's width, and the row's height with and
// without the chip (the slot reserved 44px, so the two were about equal on a
// narrow list and 43px apart on a wide one).
const BEFORE_TITLE = { 1000: 344, 1280: 204, 1600: 424 } as const;
// How much wider the title is now at each width: the wide row's repo track is
// 16px narrower. The narrow list's tracks hold the stacked status cell, so
// its title does not change.
const TITLE_GAIN = { 1000: 0, 1280: 16, 1600: 16 } as const;
const WIDTHS = [1000, 1280, 1600] as const;
const CHIP_HEIGHT = 36;
const ROW_GAP = 6;

const makePR = (overrides: MockPR = {}): MockPR => ({
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 42,
  title: 'feat(api): add a retry budget to the webhook delivery queue',
  url: 'https://example.com/42',
  author: 'claude',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'mergeable',
  behind: false,
  allowedActions: [{ action: 'merge' }, { action: 'close' }],
  ...overrides,
});

const armed = (code = 'checks_pending', overrides: MockPR = {}) =>
  makePR({
    ci: 'pending',
    mergeStatus: 'blocked',
    autoMergeEnabled: true,
    autoMerge: {
      state: 'waiting',
      code,
      message: 'Auto-merge is waiting for checks to finish.',
    },
    allowedActions: [
      { action: 'merge' },
      { action: 'close' },
      { action: 'cancel_auto_merge' },
    ],
    ...overrides,
  });

const queuedItem = () => ({
  id: 'q1',
  action: 'update_branch',
  forge: 'github',
  fullName: 'alrayyes/forge-dashboard',
  number: 42,
  status: 'queued',
  runAt: new Date(Date.now() + 8 * 60_000).toISOString(),
  createdAt: new Date().toISOString(),
});

const snapshot = (pr: MockPR, extra: MockPR = {}) => ({
  generatedAt: new Date().toISOString(),
  forges: [forgeHealth('github')],
  pullRequests: [pr],
  issues: [],
  repos: [],
  hiddenDrafts: 0,
  ...extra,
});

async function open(page: Page, width: number, pr: MockPR, extra: MockPR = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.unroute('**/api/v1/dashboard*').catch(() => {});
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(pr, extra)),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
}

const row = (page: Page) => page.locator('#pr-rows > .row').first();

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('no box');
  return b;
}

async function measure(page: Page) {
  return {
    height: (await box(row(page))).height,
    title: (await box(row(page).locator('.title-cell'))).width,
  };
}

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test('an armed row is at most one chip line taller than a chipless one, and the title keeps its width', async ({
      page,
    }) => {
      await open(page, width, makePR());
      const plain = await measure(page);
      await open(page, width, armed());
      await expect(row(page).locator('.wait-chip')).toBeVisible();
      const withChip = await measure(page);
      expect(withChip.height).toBeLessThanOrEqual(
        plain.height + CHIP_HEIGHT + ROW_GAP,
      );
      expect(withChip.title).toBe(plain.title);
      expect(withChip.title).toBeGreaterThanOrEqual(
        BEFORE_TITLE[width] + TITLE_GAIN[width],
      );
    });

    test('the chip is as wide as its content and one line tall', async ({
      page,
    }) => {
      await open(page, width, armed());
      const chip = row(page).locator('.wait-chip');
      await expect(chip).toBeVisible();
      const cell = await box(row(page).locator('.status-cell'));
      const c = await box(chip);
      expect(c.height).toBeLessThanOrEqual(CHIP_HEIGHT);
      // Capped by a narrow cell (the detail gives way), content-sized in a
      // wide one.
      expect(c.width).toBeLessThanOrEqual(cell.width);
      if (width >= 1280) expect(c.width).toBeLessThan(cell.width - 40);
      // The chip's own parts are on one line.
      const label = await box(chip.locator('.wait-chip-label'));
      const button = await box(chip.getByRole('button'));
      expect(
        Math.abs(label.y + label.height / 2 - (button.y + 15)),
      ).toBeLessThan(8);
    });
  });
}

for (const width of [1280, 1600] as const) {
  test(`at ${width}px the chip sits on the status pill's line`, async ({
    page,
  }) => {
    await open(page, width, armed());
    const chip = await box(row(page).locator('.wait-chip'));
    const pill = await box(row(page).locator('.ci-pill'));
    expect(
      Math.abs(chip.y + chip.height / 2 - (pill.y + pill.height / 2)),
    ).toBeLessThan(8);
  });
}

test.describe('the other chip states', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  const states: [string, () => MockPR, MockPR, string][] = [
    ['waiting', () => armed(), {}, 'Waiting for CI'],
    ['rate limited', () => armed('rate_limited'), {}, 'Rate limited'],
    [
      'queued',
      () =>
        makePR({ behind: true, mergeStatus: 'blocked', queued: queuedItem() }),
      { queuedActions: [queuedItem()] },
      'Queued',
    ],
  ];

  for (const [name, pr, extra, label] of states) {
    test(`${name} keeps its icon and words, and its button is 30px tall`, async ({
      page,
    }) => {
      await open(page, 1280, pr(), extra);
      const chip = row(page).locator('.wait-chip');
      await expect(chip.locator('.wait-chip-label')).toContainText(label);
      await expect(chip.locator('svg').first()).toBeVisible();
      const b = await box(chip);
      expect(b.height).toBeLessThanOrEqual(CHIP_HEIGHT);
      const button = chip.getByRole('button');
      if ((await button.count()) > 0) {
        expect((await box(button)).height).toBeGreaterThanOrEqual(30);
      }
    });
  }

  for (const width of [1280, 1600]) {
    for (const [name, pr, extra] of states) {
      test(`${name} shows its whole detail at ${width}px, in a chip narrower than the cell`, async ({
        page,
      }) => {
        await open(page, width, pr(), extra);
        const chip = row(page).locator('.wait-chip');
        await expect(chip).toBeVisible();
        const detail = chip.locator('.wait-chip-detail');
        if ((await detail.count()) > 0) {
          const fits = await detail.evaluate(
            (el) => el.scrollWidth <= el.clientWidth,
          );
          expect(fits, 'the detail is not cut by an ellipsis').toBe(true);
        }
        const cell = await box(row(page).locator('.status-cell'));
        expect((await box(chip)).width).toBeLessThan(cell.width - 40);
      });
    }
  }

  test('has no axe violations in light, dark and forced colors', async ({
    page,
  }) => {
    await open(page, 1280, armed());
    await expect(row(page).locator('.wait-chip')).toBeVisible();
    for (const media of [
      { colorScheme: 'light' },
      { colorScheme: 'dark' },
      { forcedColors: 'active' },
    ] as const) {
      await page.emulateMedia(media);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations, JSON.stringify(media)).toEqual([]);
    }
  });
});

test('an empty slot takes no room on a narrow list either', async ({
  page,
}) => {
  await open(page, 1000, makePR());
  const slot = await row(page).locator('.wait-slot').boundingBox();
  expect(slot === null || slot.height === 0).toBe(true);
});

test('the phone card keeps its full-width chip (#4593)', async ({ page }) => {
  await open(page, 390, armed());
  const chip = await box(row(page).locator('.wait-chip'));
  const cell = await box(row(page).locator('.status-cell'));
  expect(chip.height).toBe(59);
  expect(chip.width).toBeGreaterThanOrEqual(cell.width - 1);
});

// The detail gives way (an ellipsis, with the tooltip) only when the cell is
// too narrow for it. Whatever the width or root font size, the page does not
// scroll sideways and the chip stays inside its row and passes axe.
for (const width of [761, 1000, 1190, 1191, 1280, 1600]) {
  for (const rootPx of [16, 32]) {
    test(`an armed row does not overflow at ${width}px with a ${rootPx}px root font`, async ({
      page,
    }) => {
      await open(page, width, armed());
      await page.addStyleTag({ content: `html { font-size: ${rootPx}px; }` });
      const chip = row(page).locator('.wait-chip');
      await expect(chip).toBeVisible();
      const rowBox = await box(row(page));
      const c = await box(chip);
      expect(c.x + c.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
