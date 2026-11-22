import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #4591: on a phone the first action on a page revealed the Activity control
// above the list and moved every card down by about 52px, under the user's
// thumb. The control's place is kept from the start, so its first appearance
// moves nothing.
const BEHIND = {
  behind: true,
  allowedActions: [{ action: 'merge' }, { action: 'update_branch' }],
};

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

async function open(
  page: Page,
  forge: Record<string, unknown> = {},
): Promise<Locator> {
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github', forge)],
        pullRequests: [pr(BEHIND)],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/update-branch', (route) =>
    route.fulfill({ status: 202 }),
  );
  await page.goto('/pull-requests.html');
  const row = page.locator('#pr-rows > .row').first();
  await expect(row).toBeVisible();
  return row;
}

// Keeps the page's event streams so a spec can push a snapshot after an action.
async function keepStreams(page: Page) {
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
}

// The forge drops out after the action: the toolbar then shows its most
// content and the action buttons are gone, so this follows the first click.
async function dropForge(page: Page) {
  await page.evaluate(
    (data) => {
      const w = window as unknown as { __streams: EventSource[] };
      for (const stream of w.__streams)
        stream.onmessage?.(new MessageEvent('message', { data }));
    },
    JSON.stringify({
      generatedAt: new Date(Date.now() + 1000).toISOString(),
      forges: [
        forgeHealth('github', {
          reachable: false,
          errorKind: 'unreachable',
          staleSince: new Date(Date.now() - 5 * 60_000).toISOString(),
        }),
      ],
      pullRequests: [pr(BEHIND)],
      issues: [],
      repos: [],
      hiddenDrafts: 0,
    }),
  );
}

const top = (row: Locator) =>
  row.evaluate((r) => Math.round(r.getBoundingClientRect().top * 10) / 10);

test.describe('the Activity control appearing (#4591)', () => {
  for (const width of [320, 390]) {
    test(`${width}px: the first action does not move the card's top edge`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const row = await open(page);
      const before = await top(row);
      await expect(page.locator('#activity-toggle')).toBeHidden();

      await row.getByRole('button', { name: 'Update branch' }).click();
      await expect(page.locator('#activity-toggle')).toBeVisible();

      expect(await top(row)).toBe(before);
    });
  }

  for (const width of [320, 390]) {
    test(`${width}px: the control overlaps nothing in the toolbar it sits beside`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const row = await open(page);
      await row.getByRole('button', { name: 'Update branch' }).click();
      await expect(page.locator('#activity-toggle')).toBeVisible();
      const hits = await page.evaluate(() => {
        const t = document
          .getElementById('activity-toggle')!
          .getBoundingClientRect();
        return [...document.querySelectorAll('.dashboard-toolbar *')]
          .filter((e) => e.children.length === 0)
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter(
            ({ r }) =>
              r.width > 0 &&
              r.height > 0 &&
              r.left < t.right &&
              r.right > t.left &&
              r.top < t.bottom &&
              r.bottom > t.top,
          )
          .map(({ e }) => e.className || e.tagName);
      });
      expect(hits).toEqual([]);
    });
  }

  // The control is pinned, so the Activity panel and count stay reachable
  // however far the list has scrolled.
  for (const width of [320, 390]) {
    test(`${width}px: scrolled well down, the control sits 8px from the top and takes the tap`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const row = await open(page);
      await row.getByRole('button', { name: 'Update branch' }).click();
      await expect(page.locator('#activity-toggle')).toBeVisible();
      await page.evaluate(() => {
        // A long list: the control pins for as long as its page does.
        document.querySelector('.activity-bar')!
          .parentElement!.style.minHeight = '4000px';
        window.scrollTo(0, 600);
      });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .getElementById('activity-toggle')!
                .getBoundingClientRect().top,
          ),
        )
        .toBeGreaterThanOrEqual(7);
      const probe = await page.evaluate(() => {
        const t = document.getElementById('activity-toggle')!;
        const r = t.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return {
          top: Math.round(r.top),
          height: Math.round(r.height),
          hit: t.contains(hit),
        };
      });
      expect(probe.top).toBeLessThanOrEqual(9);
      expect(probe.height).toBeGreaterThanOrEqual(44);
      expect(probe.hit).toBe(true);
      await page.locator('#activity-toggle').click();
      await expect(page.locator('#activity-panel')).toBeVisible();
    });

    test(`${width}px: a stuck banner stops below the pinned control`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      // The stream is kept, so the forge can drop out after the action.
      await keepStreams(page);
      const row = await open(page);
      await row.getByRole('button', { name: 'Update branch' }).click();
      await expect(page.locator('#activity-toggle')).toBeVisible();
      await dropForge(page);
      await expect(page.locator('#unreachable-banner')).toBeVisible();
      await page.evaluate(() => {
        // A long list: the control pins for as long as its page does.
        document.querySelector('.activity-bar')!
          .parentElement!.style.minHeight = '4000px';
        window.scrollTo(0, 600);
      });
      await expect
        .poll(() =>
          page.evaluate(() => ({
            banner: Math.round(
              document
                .getElementById('unreachable-banner')!
                .getBoundingClientRect().top,
            ),
            toggleBottom: Math.round(
              document
                .getElementById('activity-toggle')!
                .getBoundingClientRect().bottom,
            ),
          })),
        )
        .toEqual({ banner: 60, toggleBottom: 52 });
    });
  }

  for (const width of [320, 390]) {
    test(`${width}px: the control at rest covers neither the first card nor the header`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const row = await open(page);
      await row.getByRole('button', { name: 'Update branch' }).click();
      await expect(page.locator('#activity-toggle')).toBeVisible();
      const gap = await page.evaluate(() => {
        const t = document
          .getElementById('activity-toggle')!
          .getBoundingClientRect();
        const c = document
          .querySelector('#pr-rows > .row')!
          .getBoundingClientRect();
        const bar = document
          .querySelector('.dashboard-toolbar')!
          .getBoundingClientRect();
        // Neither the card below nor the header above is covered at rest.
        return {
          card: c.top - t.bottom,
          toolbar: bar.bottom - t.bottom,
          // Whatever in the header the control's overhang could reach.
          header: Math.min(
            ...[...document.querySelectorAll('header *')]
              .map((e) => e.getBoundingClientRect())
              .filter(
                (r) =>
                  r.width > 0 &&
                  r.height > 0 &&
                  r.left < t.right &&
                  r.right > t.left,
              )
              .map((r) => t.top - r.bottom),
            Number.POSITIVE_INFINITY,
          ),
        };
      });
      expect(gap.card).toBeGreaterThanOrEqual(0);
      expect(gap.toolbar).toBeGreaterThanOrEqual(0);
      expect(gap.header).toBeGreaterThanOrEqual(0);
    });
  }

  test('390px: reduced motion, nothing animates when it appears', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const row = await open(page);
    await row.getByRole('button', { name: 'Update branch' }).click();
    await expect(page.locator('#activity-toggle')).toBeVisible();
    const motion = await page
      .locator('.activity-bar, .activity-toggle')
      .evaluateAll((els) =>
        els.map((e) => {
          const cs = getComputedStyle(e);
          return `${cs.transitionDuration} ${cs.animationName}`;
        }),
      );
    for (const m of motion)
      expect(m, JSON.stringify(motion)).toMatch(/^0s none$/);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`320px ${scheme}: no new axe violations and no overflow after the first action`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 844 });
      await page.emulateMedia({ colorScheme: scheme });
      const row = await open(page);
      await row.getByRole('button', { name: 'Update branch' }).click();
      await expect(page.locator('#activity-toggle')).toBeVisible();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const results = await new AxeBuilder({ page })
        .include('#pr-rows')
        .include('.activity-bar')
        .analyze();
      expect(results.violations.map((v) => v.id)).toEqual([]);
    });
  }

  // #4619: at 400% text the toolbar's content grows far past the 110px the
  // control's end padding reserves in px. A degraded forge shows the most
  // content, so the control must still overlap none of it and nothing may
  // clip or scroll sideways.
  test('320px, 400% text: a degraded forge and the control share the toolbar without overlap or clipping', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await keepStreams(page);
    const row = await open(page);
    await row.getByRole('button', { name: 'Update branch' }).click();
    await expect(page.locator('#activity-toggle')).toBeVisible();
    await dropForge(page);
    await expect(page.locator('#unreachable-banner')).toBeVisible();
    await page.addStyleTag({
      content: 'html { font-size: 400% !important; }',
    });
    const m = await page.evaluate(() => {
      const t = document
        .getElementById('activity-toggle')!
        .getBoundingClientRect();
      const tb = document.querySelector('.dashboard-toolbar')!;
      const leaves = [...tb.querySelectorAll('*')]
        .filter((e) => e.children.length === 0)
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0);
      return {
        shown: leaves.length,
        hits: leaves
          .filter(
            ({ r }) =>
              r.left < t.right &&
              r.right > t.left &&
              r.top < t.bottom &&
              r.bottom > t.top,
          )
          .map(({ e }) => e.className || e.tagName),
        clipped: leaves
          .filter(({ r }) => r.right > innerWidth + 0.5 || r.left < -0.5)
          .map(({ e }) => e.className || e.tagName),
        toggleOut: t.left < -0.5 || t.right > innerWidth + 0.5,
      };
    });
    expect(m.shown, 'the degraded forge shows content').toBeGreaterThan(0);
    expect(m.hits).toEqual([]);
    expect(m.clipped).toEqual([]);
    expect(m.toggleOut).toBe(false);
  });

  // #4619: the control's sticky offset and overlap are derived from --tap and
  // the toolbar's padding, so changing either leaves the control hanging from
  // the toolbar's bottom edge, 8px from the top when stuck.
  for (const [name, css] of [
    ['a taller --tap', ':root { --tap: 56px; }'],
    [
      'a shallower toolbar bottom padding',
      ':root { --toolbar-pad-bottom: 12px; }',
    ],
  ]) {
    test(`320px, ${name}: the control still hangs from the toolbar's bottom edge and pins 8px from the top`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 844 });
      const row = await open(page);
      await page.addStyleTag({ content: css });
      const before = await top(row);
      await row.getByRole('button', { name: 'Update branch' }).click();
      await expect(page.locator('#activity-toggle')).toBeVisible();
      expect(await top(row)).toBe(before);
      const rest = await page.evaluate(() => {
        const t = document
          .getElementById('activity-toggle')!
          .getBoundingClientRect();
        const bar = document
          .querySelector('.dashboard-toolbar')!
          .getBoundingClientRect();
        return Math.round((bar.bottom - t.bottom) * 10) / 10;
      });
      expect(rest).toBe(0);
      await page.evaluate(() => {
        document.querySelector('.activity-bar')!
          .parentElement!.style.minHeight = '4000px';
        window.scrollTo(0, 600);
      });
      await expect
        .poll(() =>
          page.evaluate(() =>
            Math.round(
              document
                .getElementById('activity-toggle')!
                .getBoundingClientRect().top,
            ),
          ),
        )
        .toBe(8);
    });
  }

  // #4619: phone width but landscape (a tall enough viewport that the short
  // landscape layout does not apply), and forced colors, which repaints the
  // control and drops its shadow.
  for (const [name, size, media] of [
    ['700x500 landscape', { width: 700, height: 500 }, {}],
    [
      '320px forced colors',
      { width: 320, height: 844 },
      { forcedColors: 'active' },
    ],
  ] as const) {
    test(`${name}: the first action moves nothing and the control overlaps nothing`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.emulateMedia(media);
      const row = await open(page);
      const before = await top(row);
      await row.getByRole('button', { name: 'Update branch' }).click();
      await expect(page.locator('#activity-toggle')).toBeVisible();
      expect(await top(row)).toBe(before);
      const m = await page.evaluate(() => {
        const toggle = document.getElementById('activity-toggle')!;
        const t = toggle.getBoundingClientRect();
        const bar = document
          .querySelector('.dashboard-toolbar')!
          .getBoundingClientRect();
        const c = document
          .querySelector('#pr-rows > .row')!
          .getBoundingClientRect();
        return {
          hung: Math.round((bar.bottom - t.bottom) * 10) / 10,
          card: c.top - t.bottom,
          border: getComputedStyle(toggle).borderTopWidth,
        };
      });
      expect(m.hung).toBe(0);
      expect(m.card).toBeGreaterThanOrEqual(0);
      expect(m.border).not.toBe('0px');
    });
  }
});
