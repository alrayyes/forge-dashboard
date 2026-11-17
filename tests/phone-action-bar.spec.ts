import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #4099: on a phone a locked Merge took the whole line and pushed Update
// branch under it, so a row with both spent 107px on its action bar where 55px
// was enough. The locked Merge takes its content width like the plain one, and
// the pair share a line at every phone width, 320px included. The 52px wait
// slot above the bar stays (#1229); only the bar's own height is pinned here.
const TAP = 44;
// 330 and 333 fit only because of the narrow rule; 340 and 341 sit either side
// of its breakpoint.
const WIDTHS = [320, 330, 333, 340, 341, 360, 390, 412];
const BREAKPOINT = 340;

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

const WAITING_ON_CI = {
  code: 'checks_pending',
  message: 'Waiting for CI to finish',
  next: 'Merge unlocks automatically',
};

const shapes = {
  'locked Merge + Update branch': {
    ci: 'pending',
    mergeStatus: 'blocked',
    behind: true,
    allowedActions: [
      { action: 'merge', blocked: WAITING_ON_CI },
      { action: 'update_branch' },
    ],
  },
  'plain Merge + Update branch': {
    behind: true,
    allowedActions: [
      { action: 'merge', primary: true },
      { action: 'update_branch' },
    ],
  },
  'only Merge': {},
  'only Update branch': {
    ci: 'pending',
    mergeStatus: 'blocked',
    behind: true,
    allowedActions: [{ action: 'update_branch', primary: true }],
  },
} as const;

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
        forges: [forgeHealth('github')],
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

const measure = (page: Page) =>
  page.evaluate(() => {
    const row = document.querySelector('#pr-rows > .row');
    if (!row) return { barHeight: 0, buttons: [], overflow: false };
    const rowBox = row.getBoundingClientRect();
    const bar = row.querySelector('.row-action-bar')?.getBoundingClientRect();
    const buttons = [
      ...row.querySelectorAll('.row-action-bar button, .status-cell button'),
    ]
      .filter((b) => /^(Merge|Update branch)/.test(b.textContent?.trim() ?? ''))
      .map((b) => {
        const r = b.getBoundingClientRect();
        return {
          label: b.textContent?.trim(),
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          inside: r.left >= rowBox.left - 0.5 && r.right <= rowBox.right + 0.5,
        };
      });
    return {
      barHeight: bar?.height ?? 0,
      buttons,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });

for (const [name, extra] of Object.entries(shapes)) {
  for (const width of WIDTHS) {
    test(`${width}px, ${name}: one line, 44px tall, no overflow`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await open(page, pr(extra));
      await expect
        .poll(async () => (await measure(page)).buttons.length)
        .toBeGreaterThan(0);
      const m = await measure(page);
      const msg = JSON.stringify(m);
      expect(m.overflow, msg).toBe(false);
      for (const b of m.buttons) {
        expect(b.h, msg).toBeGreaterThanOrEqual(TAP);
        expect(b.inside, msg).toBe(true);
      }
      if (m.buttons.length === 2) {
        const [a, b] = m.buttons;
        // Same line, side by side, not stacked.
        expect(Math.abs(a.y - b.y), msg).toBeLessThanOrEqual(1);
        expect(b.x, msg).toBeGreaterThanOrEqual(a.x + a.w);
        expect(m.barHeight, msg).toBeLessThanOrEqual(TAP + 10 + 1 + 4 + 1);
      }
      // The narrow rule applies at the breakpoint and not above it.
      const merge = m.buttons.find((b) => b.label === 'Merge');
      if (merge) {
        if (width > BREAKPOINT) expect(merge.w, msg).toBeCloseTo(120, 0);
        else expect(merge.w, msg).toBeLessThanOrEqual(100.5);
      }
      if (m.buttons.length === 1 && m.barHeight > 0) {
        expect(m.barHeight, msg).toBeLessThanOrEqual(TAP + 10 + 1 + 4 + 1);
      }
    });
  }
}

test('a locked Merge keeps its size when Update branch goes away', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, pr(shapes['locked Merge + Update branch']));
  await expect.poll(async () => (await measure(page)).buttons.length).toBe(2);
  const both = (await measure(page)).buttons[0];
  await page.unroute('**/api/v1/dashboard*');
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [
          pr({
            ci: 'pending',
            mergeStatus: 'blocked',
            allowedActions: [{ action: 'merge', blocked: WAITING_ON_CI }],
          }),
        ],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.reload();
  await expect(page.locator('#pr-rows > .row').first()).toBeVisible();
  await expect.poll(async () => (await measure(page)).buttons.length).toBe(1);
  const alone = (await measure(page)).buttons[0];
  expect(alone.w).toBeCloseTo(both.w, 0);
  expect(alone.h).toBeCloseTo(both.h, 0);
  expect(alone.x).toBeCloseTo(both.x, 0);
});

test('axe finds nothing on the locked Merge + Update row in light and dark', async ({
  page,
}) => {
  for (const scheme of ['light', 'dark'] as const) {
    await test.step(scheme, async () => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 320, height: 844 });
      await open(page, pr(shapes['locked Merge + Update branch']));
      const results = await new AxeBuilder({ page })
        .include('#pr-rows')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

const OWN_NOTE = {
  ci: 'success',
  behind: true,
  allowedActions: [
    {
      action: 'merge',
      blocked: {
        code: 'review_required',
        message: 'A review is required',
        next: 'Ask for an approval',
      },
    },
    { action: 'update_branch' },
  ],
};

for (const width of [320, 390]) {
  test(`${width}px: a locked Merge that prints its own note keeps the full line`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const row = await open(page, pr(OWN_NOTE));
    await expect(row.locator('.row-action-locked-visible')).toBeVisible();
    const m = await measure(page);
    const wrap = await row.locator('.row-action-locked-visible').boundingBox();
    const bar = await row.locator('.row-action-bar').boundingBox();
    const msg = JSON.stringify({ m, wrap, bar });
    expect(wrap?.width, msg).toBeGreaterThanOrEqual((bar?.width ?? 0) - 1);
    const update = m.buttons.find((b) => b.label === 'Update branch');
    const merge = m.buttons.find((b) => b.label === 'Merge');
    // Update branch wraps under the note, not beside it.
    expect(update?.y, msg).toBeGreaterThan((merge?.y ?? 0) + (merge?.h ?? 0));
    expect(m.overflow, msg).toBe(false);
  });
}

test('1280px: the desktop row bar is untouched', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const row = await open(page, pr(shapes['locked Merge + Update branch']));
  await expect(row.locator('.row-action-bar')).toHaveCSS('display', 'contents');
  const m = await measure(page);
  expect(m.buttons.length).toBeGreaterThan(0);
  for (const b of m.buttons) expect(b.h).toBeLessThan(TAP);
});
