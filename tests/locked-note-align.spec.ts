import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import {
  actionsFooter,
  closeActionsDialog,
  openActionsDialog,
} from './actions-dialog-helper';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The locked Merge note and the Close-locked cue are plain text next to the
// status pills. From 1191px of list width the pills and the action are
// left-aligned in their slots, but the notes kept a right-aligned column of
// their own. They now start on the same x as the pills. Narrower than that the
// status cell wraps and right-justifies everything, so the notes keep their
// right edge there, which is the button's. A phone card is unchanged.
// https://github.com/alrayyes/forge-dashboard/issues/4602

function pr(number: number, over: Record<string, unknown>) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `PR ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    ...over,
  };
}

const PRS = [
  pr(1, {
    title: 'Locked merge',
    allowedActions: [
      {
        action: 'merge',
        blocked: {
          code: 'review_required',
          message: 'A review is required',
          next: 'Ask for an approval',
        },
      },
      { action: 'close' },
    ],
  }),
  pr(2, {
    title: 'Close locked',
    allowedActions: [{ action: 'merge', primary: true }, { action: 'close' }],
  }),
];

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/v1/dashboard*', (r: Route) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: PRS,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/close', (r: Route) =>
    r.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'github: 403 Resource not accessible by integration',
        code: 'permission',
        message: "This token can't close pull requests on this repository.",
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
  const row = page.locator('#pr-rows > .row').nth(1);
  const dialog = await openActionsDialog(row);
  const footer = actionsFooter(dialog);
  await footer
    .getByRole('button', { name: 'Close pull request', exact: true })
    .click();
  await footer
    .getByRole('button', { name: 'Confirm close pull request?' })
    .click();
  await closeActionsDialog(dialog);
  await expect(row.locator('.row-lock-cue')).toBeVisible();
}

const rows = (page: Page): { merge: Locator; close: Locator } => ({
  merge: page.locator('#pr-rows > .row').nth(0),
  close: page.locator('#pr-rows > .row').nth(1),
});

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error('not laid out');
  return { left: b.x, right: b.x + b.width, height: b.height };
};

const BEFORE_HEIGHT = { 1280: [88, 101], 1600: [88, 101] } as const;

for (const width of [1280, 1600] as const) {
  test.describe(`at ${width}px (#4602)`, () => {
    test('the locked Merge and its note start where the pills do', async ({
      page,
    }) => {
      await open(page, width);
      const { merge } = rows(page);
      const note = merge.locator('.row-action-note');
      const btn = merge.locator('.row-action-locked .row-action');
      const bar = merge.locator('.row-action-bar');
      const n = await box(note);
      const b = await box(btn);
      const s = await box(bar);
      // The button and its note share the action slot's left edge.
      expect(Math.abs(b.left - s.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(n.left - s.left)).toBeLessThanOrEqual(1);
      expect(await note.evaluate((e) => getComputedStyle(e).textAlign)).toBe(
        'left',
      );
      // The slot is where the next row's live button would be.
      expect(n.right).toBeLessThanOrEqual(s.right + 1);
    });

    test('the Close cue starts at the CI pill and is left-aligned', async ({
      page,
    }) => {
      await open(page, width);
      const { close } = rows(page);
      const cue = close.locator('.row-lock-cue');
      const c = await box(cue);
      const ci = await box(close.locator('.ci-pill'));
      expect(Math.abs(c.left - ci.left)).toBeLessThanOrEqual(1);
      expect(await cue.evaluate((e) => getComputedStyle(e).textAlign)).toBe(
        'left',
      );
      await expect(cue.locator('.row-action-note-reason')).toHaveText(
        'Close locked',
      );
    });

    test('the rows are no taller than they were', async ({ page }) => {
      await open(page, width);
      const r = rows(page);
      const heights = [
        (await box(r.merge)).height,
        (await box(r.close)).height,
      ];
      expect(heights[0]).toBeLessThanOrEqual(BEFORE_HEIGHT[width][0] + 1);
      expect(heights[1]).toBeLessThanOrEqual(BEFORE_HEIGHT[width][1] + 1);
    });
  });
}

test('at 1000px the notes keep the right edge of the button and the cell (#4602)', async ({
  page,
}) => {
  await open(page, 1000);
  const { merge, close } = rows(page);
  const n = await box(merge.locator('.row-action-note'));
  const b = await box(merge.locator('.row-action-locked .row-action'));
  expect(Math.abs(n.right - b.right)).toBeLessThanOrEqual(1);
  const c = await box(close.locator('.row-lock-cue'));
  const cell = await box(close.locator('.status-cell'));
  expect(Math.abs(c.right - cell.right)).toBeLessThanOrEqual(1);
});

test('the phone card keeps its left-aligned note (#4602)', async ({ page }) => {
  await open(page, 390);
  const note = rows(page).merge.locator('.row-action-note');
  expect(await note.evaluate((e) => getComputedStyle(e).textAlign)).toBe(
    'left',
  );
  expect(await note.evaluate((e) => getComputedStyle(e).maxWidth)).toBe('none');
});

for (const width of [1000, 1280, 1600]) {
  for (const [label, emulate] of [
    ['light', { colorScheme: 'light' }],
    ['dark', { colorScheme: 'dark' }],
    ['forced colors', { forcedColors: 'active' }],
  ] as const) {
    test(`axe finds nothing at ${width}px in ${label} (#4602)`, async ({
      page,
    }) => {
      await page.emulateMedia(emulate);
      await open(page, width);
      const results = await new AxeBuilder({ page })
        .include('#pr-rows')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
