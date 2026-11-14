import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// One placement rule for the three bulk actions (#3755): Update all, Rerun
// failed checks and Rebase all sit in the header's controls block, after the
// live control and before the count, as secondary (outlined) buttons. No strip
// under the header. On a phone they stack, one full-width 44px button a line.

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Change number ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'failure',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    allowedActions: [{ action: 'update_branch' }, { action: 'rerun_checks' }],
    ...overrides,
  };
}

async function open(
  page: Page,
  path: '/pull-requests.html' | '/bots.html',
  rows: ReturnType<typeof pr>[],
  hold?: Promise<void>,
  hidden = 0,
) {
  const snapshot = () =>
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
      pullRequests: rows,
      issues: [],
      repos: [],
      hiddenDrafts: 0,
      hiddenPullRequests: hidden,
    });
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route(/\/api\/v1\/dashboard(\/refresh)?(\?.*)?$/, (r: Route) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    }),
  );
  await page.route('**/api/v1/pull-requests/rerunnable*', (r: Route) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rerunnable: true }),
    }),
  );
  await page.route(
    '**/api/v1/pull-requests/update-branch',
    async (r: Route) => {
      if (hold) await hold;
      await r.fulfill({ status: 204 });
    },
  );
  await page.goto(path);
}

const SIZES = [360, 390, 820, 1280];
const bots = [
  pr(1, {
    author: 'dependabot[bot]',
    allowedActions: [
      { action: 'rerun_checks' },
      { action: 'dependabot_rebase' },
    ],
  }),
];

// WCAG relative luminance contrast of two CSS rgb() strings.
function ratio(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
      const s = Number(v) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of SIZES) {
    test(`Update all and Rerun sit in the header controls at ${width}px, ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await open(page, '/pull-requests.html', [pr(1), pr(2)]);
      const update = page.getByRole('button', { name: 'Update all (2)' });
      const rerun = page.getByRole('button', {
        name: 'Rerun failed checks (2)',
      });
      await expect(update).toBeVisible();
      await expect(rerun).toBeVisible();
      await expect(page.locator('section.board > .update-all')).toHaveCount(0);

      const m = await page.evaluate(() => {
        const r = (s: string) =>
          document.querySelector(s)!.getBoundingClientRect();
        const css = (s: string) => getComputedStyle(document.querySelector(s)!);
        const surface = getComputedStyle(document.body)
          .getPropertyValue('--surface')
          .trim();
        return {
          controls: r('.board-head-controls'),
          head: r('.board-head'),
          live: r('.live-control'),
          update: r('#update-all-button'),
          rerun: r('#rerun-all-button'),
          count: r('#pr-count'),
          color: css('#update-all-button').color,
          bg: css('#update-all-button').backgroundColor,
          border: css('#update-all-button').borderTopColor,
          surfaceVar: surface,
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
        };
      });
      // Inside the header, after the live control.
      expect(m.update.top).toBeGreaterThanOrEqual(m.head.top);
      expect(m.update.bottom).toBeLessThanOrEqual(m.head.bottom + 8);
      expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
      // Contrast: text 4.5:1, border 3:1 against the button's own fill.
      expect(ratio(m.color, m.bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(m.border, m.bg)).toBeGreaterThanOrEqual(3);
      if (width <= 760) {
        // Stacked: one per line, full width, at least 44px.
        expect(m.update.height).toBeGreaterThanOrEqual(44);
        expect(m.rerun.height).toBeGreaterThanOrEqual(44);
        expect(m.rerun.top).toBeGreaterThanOrEqual(m.update.bottom);
        expect(m.update.width).toBeGreaterThan(width - 80);
        // The live control is 261px wide, so the count follows it on the same
        // line when there is room and on the next when there isn't; either
        // way both come before the buttons.
        expect(m.count.top).toBeGreaterThanOrEqual(m.live.top);
        expect(m.update.top).toBeGreaterThan(m.count.bottom - 1);
        expect(m.update.top).toBeGreaterThan(m.live.bottom - 1);
      } else {
        // Desktop: live control, then the buttons, then the count, one line.
        expect(m.update.left).toBeGreaterThan(m.live.right - 1);
        expect(m.rerun.left).toBeGreaterThan(m.update.right - 1);
        expect(m.count.left).toBeGreaterThan(m.rerun.right - 1);
        expect(m.update.height).toBeGreaterThanOrEqual(28);
      }
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test(`Rebase all sits in the Bots header at 390px, ${scheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 900 });
    await open(page, '/bots.html', bots);
    const rebase = page.getByRole('button', { name: /^Rebase all/ });
    await expect(rebase).toBeVisible();
    expect((await rebase.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('section.board > .rebase-all')).toHaveCount(0);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('Updating 2 of 2 keeps the idle width and full-contrast text', async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((res) => {
    release = res;
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, '/pull-requests.html', [pr(1), pr(2)], hold);
  const button = page.locator('#update-all-button');
  await expect(button).toBeVisible();
  const idle = (await button.boundingBox())!;
  await button.click();
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(button).toHaveText(/Updating 0 of 2/);
  const busy = (await button.boundingBox())!;
  expect(Math.abs(busy.width - idle.width)).toBeLessThan(1);
  expect(Math.abs(busy.x - idle.x)).toBeLessThan(1);
  await expect(button).toHaveCSS('opacity', '1');
  release();
});

// The tab order is the reading order (WCAG 2.4.3, 1.3.2): the focusable
// controls of the header, in DOM order, are also in visual order (top to
// bottom, then left to right).
for (const width of [390, 1280]) {
  test(`the header's tab order is its visual order at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, '/pull-requests.html', [pr(1), pr(2)], undefined, 2);
    await expect(page.locator('#hidden-prs-toggle')).toBeVisible();
    await expect(page.locator('#update-all-button')).toBeVisible();
    const order = await page.evaluate(() => {
      const items = [
        ...document.querySelectorAll<HTMLElement>(
          '.board-head-controls button, .board-head-controls a',
        ),
      ].filter((el) => el.getClientRects().length > 0);
      const dom = items.map((el) => el.id || el.textContent?.trim() || '?');
      const visual = [...items]
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          // Same line within a few pixels counts as one row.
          return Math.abs(ra.top - rb.top) > 8
            ? ra.top - rb.top
            : ra.left - rb.left;
        })
        .map((el) => el.id || el.textContent?.trim() || '?');
      return { dom, visual };
    });
    expect(order.dom).toContain('update-all-button');
    expect(order.dom).toContain('hidden-prs-toggle');
    expect(order.dom).toEqual(order.visual);
    // And Tab really walks it.
    await page.locator('.live-control button').first().focus();
    const walked: string[] = [];
    for (let i = 0; i < order.dom.length; i++) {
      walked.push(
        await page.evaluate(
          () =>
            document.activeElement?.id ||
            document.activeElement?.textContent?.trim() ||
            '?',
        ),
      );
      await page.keyboard.press('Tab');
    }
    expect(walked.join('|')).toBe(order.dom.slice(0, walked.length).join('|'));
  });
}

// A header with the buttons is as tall as one without them, on a desktop, so
// a row turning failing or behind moves nothing below it.
for (const width of [820, 1280]) {
  test(`the header height doesn't change when the buttons appear at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const quiet = pr(1, { ci: 'success', behind: false, allowedActions: [] });
    await open(page, '/pull-requests.html', [quiet, { ...quiet, number: 2 }]);
    await expect(page.locator('#pr-count')).toHaveText(/open/);
    await expect(page.locator('.bulk-action:not([hidden])')).toHaveCount(0);
    const without = (await page.locator('.board-head').boundingBox())?.height;
    const rowTop = (await page.locator('.row').first().boundingBox())?.y;

    const other = await page.context().newPage();
    await other.setViewportSize({ width, height: 900 });
    await open(other, '/pull-requests.html', [pr(1), pr(2)]);
    await expect(other.locator('#update-all-button')).toBeVisible();
    await expect(other.locator('#rerun-all-button')).toBeVisible();
    const withIt = (await other.locator('.board-head').boundingBox())?.height;
    expect(withIt).toBe(without);
    expect((await other.locator('.row').first().boundingBox())?.y).toBe(rowTop);
    await other.close();
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`an unavailable Rebase all looks unavailable and stays readable, ${scheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    // Out of date, but no rebase is offered: shown and unavailable.
    await open(page, '/bots.html', [
      pr(1, {
        author: 'dependabot[bot]',
        allowedActions: [{ action: 'rerun_checks' }],
      }),
    ]);
    const button = page.locator('#rebase-all-button');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    const m = await button.evaluate((el) => {
      const c = getComputedStyle(el);
      return {
        color: c.color,
        bg: c.backgroundColor,
        border: c.borderTopColor,
        style: c.borderTopStyle,
        accent: getComputedStyle(document.documentElement)
          .getPropertyValue('--accent')
          .trim(),
        // The tokens, resolved, so the test names the colours and not only
        // a ratio any grey could pass.
        ink2: resolve('--ink-2'),
        ink3: resolve('--ink-3'),
      };
      function resolve(token: string) {
        const probe = document.createElement('i');
        probe.style.color = `var(${token})`;
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      }
    });
    expect(m.style).toBe('dashed');
    expect(m.color).toBe(m.ink2);
    expect(m.border).toBe(m.ink3);
    expect(ratio(m.color, m.bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(m.border, m.bg)).toBeGreaterThanOrEqual(3);
    // Not the accent of an available button.
    const live = page.locator('#rerun-all-button');
    await expect(live).toBeVisible();
    const accent = await live.evaluate((el) => getComputedStyle(el).color);
    expect(m.color).not.toBe(accent);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('both actions and the Hidden toggle fit 320px without overlap', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await open(page, '/pull-requests.html', [pr(1), pr(2)], undefined, 2);
  const boxes = await page.evaluate(() =>
    [
      '.live-control',
      '#hidden-prs-toggle',
      '#pr-count',
      '#update-all-button',
      '#rerun-all-button',
    ].map((s) => {
      const r = document.querySelector(s)?.getBoundingClientRect();
      return {
        s,
        l: r?.left ?? 0,
        r: r?.right ?? 0,
        t: r?.top ?? 0,
        b: r?.bottom ?? 0,
      };
    }),
  );
  for (const [i, a] of boxes.entries())
    for (const b of boxes.slice(i + 1))
      expect(
        a.r <= b.l + 0.5 ||
          b.r <= a.l + 0.5 ||
          a.b <= b.t + 0.5 ||
          b.b <= a.t + 0.5,
        `${a.s} overlaps ${b.s}`,
      ).toBe(true);
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

test('forced colors keep the buttons visible with a border', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, '/pull-requests.html', [pr(1), pr(2)]);
  for (const id of ['#update-all-button', '#rerun-all-button']) {
    const m = await page.locator(id).evaluate((el) => {
      const c = getComputedStyle(el);
      return {
        width: Number.parseFloat(c.borderTopWidth),
        style: c.borderTopStyle,
        color: c.color,
        bg: c.backgroundColor,
      };
    });
    expect(m.width).toBeGreaterThanOrEqual(1);
    expect(m.style).not.toBe('none');
    // Forced colors map text and fill to different system colors.
    expect(m.color).not.toBe(m.bg);
  }
});

// A phone held sideways is 375px tall: stacked 44px buttons would push the
// first list row off the screen (#3406). In a short landscape viewport the
// buttons share one line.
for (const size of [
  { width: 667, height: 375 },
  { width: 844, height: 390 },
]) {
  test(`both actions share one line and a row shows at ${size.width}x${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await open(page, '/pull-requests.html', [pr(1), pr(2)]);
    const update = page.locator('#update-all-button');
    const rerun = page.locator('#rerun-all-button');
    await expect(update).toBeVisible();
    await expect(rerun).toBeVisible();
    const u = (await update.boundingBox())!;
    const r = (await rerun.boundingBox())!;
    expect(Math.abs(u.y - r.y)).toBeLessThan(2);
    const row = (await page.locator('#pr-rows > .row').first().boundingBox())!;
    expect(row.y + 24).toBeLessThanOrEqual(size.height);
  });
}
