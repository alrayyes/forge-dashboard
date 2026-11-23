import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #4601: a stopped auto-merge reads in the waiting chip's design language, an
// icon and a bordered shape, as wide as its words and on the status pill's
// line, instead of a plain text line that took the cell's full width. The
// words stay ("Auto-merge stopped"), and the server's whole sentence is the
// chip's tooltip, open on hover and on keyboard focus, and its accessible
// description. The phone card keeps its text line.

type MockPR = Record<string, unknown>;

const WIDTHS = [1000, 1280, 1600] as const;
// The chip is 30px tall. The one-line row (1191px and up) is already as tall
// as that, and a narrower list's first line is the 24px pill line, so there
// the row grows by the 6px difference and no more. Before #4601 the text line
// made the row 84px at 1000px (48px without it) and 67px at 1280px and 1600px
// (53px without it).
const SLACK = { 1000: 6, 1280: 0, 1600: 0 } as const;

const CHECK_FAILED =
  'Auto-merge stopped: a check failed. It carries on once checks pass.';
const CONFLICT =
  'Auto-merge stopped: merge conflict. Resolve it on the forge and it carries on.';
// The longest kind of sentence the server builds: a forge's own refusal after
// the prefix (internal/dashboard/auto_merge_status.go).
const REFUSED =
  'Auto-merge stopped: the forge refused the merge because a required reviewer has not approved yet and the branch protection rule needs two approvals. Ask for a review and it carries on.';

const makePR = (overrides: MockPR = {}): MockPR => ({
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 42,
  title: 'feat(api): add a retry budget to the webhook delivery queue',
  url: 'https://example.com/42',
  author: 'claude',
  draft: false,
  ci: 'failure',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'mergeable',
  behind: false,
  allowedActions: [{ action: 'merge' }, { action: 'close' }],
  ...overrides,
});

const stopped = (message = CHECK_FAILED, code = 'checks_failing') =>
  makePR({
    autoMergeEnabled: true,
    autoMerge: { state: 'stopped', code, message },
    allowedActions: [
      { action: 'merge' },
      { action: 'close' },
      { action: 'cancel_auto_merge' },
    ],
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
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [pr],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
        ...extra,
      }),
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

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test('a stopped row is no taller than an armed one with no stopped line', async ({
      page,
    }) => {
      await open(page, width, makePR({ autoMergeEnabled: true }));
      const plain = (await box(row(page))).height;
      await open(page, width, stopped());
      const withLine = (await box(row(page))).height;
      test.info().annotations.push({
        type: 'row height',
        description: `${width}px: ${plain}px without, ${withLine}px with`,
      });
      expect(withLine).toBeLessThanOrEqual(plain + SLACK[width]);
    });

    test('the stopped line is a content-sized chip with an icon and its words', async ({
      page,
    }) => {
      await open(page, width, stopped());
      const chip = row(page).locator('.wait-chip');
      await expect(chip).toBeVisible();
      await expect(chip.locator('.wait-chip-label')).toHaveText(
        'Auto-merge stopped',
      );
      await expect(chip.locator('svg').first()).toBeVisible();
      await expect(row(page).locator('.auto-merge-status')).toBeHidden();
      const cell = await box(row(page).locator('.status-cell'));
      const c = await box(chip);
      expect(c.height).toBeLessThanOrEqual(36);
      expect(c.width).toBeLessThan(cell.width - 40);
      const pill = await box(row(page).locator('.ci-pill'));
      expect(
        Math.abs(c.y + c.height / 2 - (pill.y + pill.height / 2)),
        'the chip is on the pill line',
      ).toBeLessThan(8);
    });
  });
}

for (const [name, message] of [
  ['a failed check', CHECK_FAILED],
  ['a merge conflict', CONFLICT],
  ['a long refusal', REFUSED],
] as const) {
  test.describe(name, () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test('keeps the whole sentence reachable from the chip, on hover and on focus', async ({
      page,
    }) => {
      await open(page, 1280, stopped(message, 'conflict'));
      const chip = row(page).locator('.wait-chip');
      const tip = chip.locator('.wait-chip-tip');
      // Said whole, never cut: the tooltip wraps, and the chip's accessible
      // description is that same text, with the forge named from its label.
      await expect(tip).toHaveText(message.replace('the forge', 'GitHub'));
      const tipId = await tip.getAttribute('id');
      await expect(chip).toHaveAttribute('aria-describedby', tipId ?? '');
      await expect(tip).toHaveCSS('opacity', '0');
      await chip.focus();
      await expect(tip).toHaveCSS('opacity', '1');
      const t = await box(tip);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x + t.width).toBeLessThanOrEqual(1280);
      const cut = await tip.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      expect(cut, 'the tooltip is not cut sideways').toBe(false);
    });
  });
}

test.describe('themes', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('has no axe violations in light, dark and forced colors', async ({
    page,
  }) => {
    await open(page, 1280, stopped());
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

test('the phone card keeps its text line and draws no chip', async ({
  page,
}) => {
  await open(page, 390, stopped());
  const line = row(page).locator('.auto-merge-status');
  await expect(line).toBeVisible();
  await expect(line).toContainText(`Stopped: ${CHECK_FAILED}`);
  await expect(row(page).locator('.wait-chip')).toBeHidden();
  const slot = await row(page).locator('.wait-slot').boundingBox();
  expect(slot === null || slot.height === 0).toBe(true);
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

// The chip must not shadow another chip with a control: a queued Update
// branch keeps its Cancel, and the stopped sentence stays on the row as text.
for (const width of [390, 1280]) {
  test(`a stopped row with a queued action keeps the queued chip and its Cancel at ${width}px`, async ({
    page,
  }) => {
    await open(
      page,
      width,
      { ...stopped(), behind: true, queued: queuedItem() },
      { queuedActions: [queuedItem()] },
    );
    const chip = row(page).locator('.wait-chip');
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText('Queued');
    await expect(chip.getByRole('button', { name: /Cancel/ })).toBeVisible();
    await expect(row(page).locator('.auto-merge-status')).toBeVisible();
  });
}

test.describe('the tooltip (WCAG 1.4.13)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('is hoverable, persistent while hovered, and dismissed by Escape', async ({
    page,
  }) => {
    await open(page, 1280, stopped(REFUSED, 'conflict'));
    const chip = row(page).locator('.wait-chip');
    const tip = chip.locator('.wait-chip-tip');
    await chip.hover();
    await expect(tip).toHaveCSS('opacity', '1');
    // The pointer crosses the gap to the tooltip without it going away.
    const t = await box(tip);
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 });
    await expect(tip).toHaveCSS('opacity', '1');
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCSS('opacity', '0');
    // Leaving and coming back opens it again.
    await page.mouse.move(5, 5);
    await chip.hover();
    await expect(tip).toHaveCSS('opacity', '1');
  });

  test('keyboard focus opens it and Escape closes it', async ({ page }) => {
    await open(page, 1280, stopped());
    const chip = row(page).locator('.wait-chip');
    const tip = chip.locator('.wait-chip-tip');
    await chip.focus();
    await expect(tip).toHaveCSS('opacity', '1');
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCSS('opacity', '0');
  });
});

test('from 861px a narrow list widens the status column for the chip', async ({
  page,
}) => {
  await open(page, 1000, makePR({ autoMergeEnabled: true }));
  const plain = (await box(row(page).locator('.status-cell'))).width;
  await open(page, 1000, stopped());
  const withChip = (await box(row(page).locator('.status-cell'))).width;
  expect(plain).toBe(280);
  expect(withChip).toBe(400);
});
