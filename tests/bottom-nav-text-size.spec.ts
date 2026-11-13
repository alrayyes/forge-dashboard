import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3830
//
// At a 125% root font size on a 390px phone the bottom tab bar stayed on one
// row, so "Insights" and "Webhooks" collided and "Branches" and "Settings"
// ran off the viewport edges. Every tab must keep clear of its neighbours and
// inside the viewport at each text size, and the bar stays one row with 44px
// hit areas at the default size.

async function open(page: Page, width: number, pct: number) {
  // A count that isn't known yet keeps its tab in the bar, so with the
  // dashboard read refused all eight tabs show.
  await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
  await page.route('**/api/v1/dashboard*', (r) => r.abort());
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/insights.html');
  if (pct !== 100) {
    await page.addStyleTag({
      content: `html { font-size: ${pct}% !important; }`,
    });
  }
  await expect(page.locator('.bottom-nav-label')).toHaveCount(8);
  await page.evaluate(() => document.fonts.ready);
}

const measure = (page: Page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const tabs = [...document.querySelectorAll('.bottom-nav-link')].map(
      (link) => {
        const label = link.querySelector('.bottom-nav-label');
        if (!label) throw new Error('tab without a label');
        const t = link.getBoundingClientRect();
        const l = label.getBoundingClientRect();
        return {
          text: label.textContent ?? '',
          tab: { l: t.left, r: t.right, t: t.top, b: t.bottom },
          label: { l: l.left, r: l.right, t: l.top, b: l.bottom },
          clipped: label.scrollWidth > label.clientWidth + 1,
        };
      },
    );
    const overlap = (
      a: { l: number; r: number; t: number; b: number },
      c: { l: number; r: number; t: number; b: number },
    ) =>
      a.l < c.r - 0.5 && c.l < a.r - 0.5 && a.t < c.b - 0.5 && c.t < a.b - 0.5;
    const problems: string[] = [];
    for (const a of tabs) {
      if (a.tab.l < -0.5 || a.tab.r > vw + 0.5)
        problems.push(`${a.text} tab outside`);
      if (a.label.l < -0.5 || a.label.r > vw + 0.5)
        problems.push(`${a.text} outside`);
      if (a.label.l < a.tab.l - 0.5 || a.label.r > a.tab.r + 0.5)
        problems.push(`${a.text} spills out of its tab`);
      if (a.clipped) problems.push(`${a.text} clipped`);
    }
    for (let i = 0; i < tabs.length; i++) {
      for (let j = i + 1; j < tabs.length; j++) {
        if (overlap(tabs[i].tab, tabs[j].tab))
          problems.push(`${tabs[i].text} tab overlaps ${tabs[j].text}`);
        if (overlap(tabs[i].label, tabs[j].label))
          problems.push(`${tabs[i].text} overlaps ${tabs[j].text}`);
      }
    }
    const rows = new Set(tabs.map((t) => Math.round(t.tab.t))).size;
    const minWidth = Math.min(...tabs.map((t) => t.tab.r - t.tab.l));
    const minHeight = Math.min(...tabs.map((t) => t.tab.b - t.tab.t));
    return { problems, rows, minWidth, minHeight };
  });

test.describe('bottom nav at larger text sizes (#3830)', () => {
  for (const pct of [125, 150, 175, 200]) {
    test(`labels stay apart and inside the viewport at ${pct}% and 390px`, async ({
      page,
    }) => {
      await open(page, 390, pct);
      await expect.poll(async () => (await measure(page)).problems).toEqual([]);
    });
  }

  // The label is a size larger over 380px, so the bar needs more room there.
  test('labels stay apart and inside the viewport at 125% and 412px', async ({
    page,
  }) => {
    await open(page, 412, 125);
    await expect.poll(async () => (await measure(page)).problems).toEqual([]);
  });

  for (const width of [320, 360, 390]) {
    test(`the bar is one row with 44px hit areas at 100% and ${width}px`, async ({
      page,
    }) => {
      await open(page, width, 100);
      await expect.poll(async () => (await measure(page)).rows).toBe(1);
      const m = await measure(page);
      expect(m.problems).toEqual([]);
      expect(m.minHeight).toBeGreaterThanOrEqual(44);
      // 44px wide from 360px up; 32px below it, over WCAG 2.5.8's 24px.
      expect(m.minWidth).toBeGreaterThanOrEqual(width >= 360 ? 44 : 32);
    });
  }

  // 384px is 24em at the default size, so a cut-off written "max-width: 24em"
  // wrapped the bar to two rows at 381 to 384px.
  for (const width of [381, 382, 383, 384, 385]) {
    test(`the bar stays one row at 100% and ${width}px`, async ({ page }) => {
      await open(page, width, 100);
      await expect.poll(async () => (await measure(page)).rows).toBe(1);
      expect((await measure(page)).problems).toEqual([]);
    });
  }

  test('labels stay apart and inside the viewport at 125% and 360px', async ({
    page,
  }) => {
    await open(page, 360, 125);
    await expect.poll(async () => (await measure(page)).problems).toEqual([]);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe finds nothing at 125% and 390px in ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 390, 125);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('axe finds nothing at 125% and 390px in forced colors', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, 390, 125);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
