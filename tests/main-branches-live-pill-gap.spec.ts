import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { mainBranchPageOf } from './nav-counts-helper';
import { test } from './server-fixture';

// On a phone the Live pill sat on the filter card with no gap (#4927). The
// gap under the pill is the gap between the card and the first repo card
// below it. The other boards keep their pill inside the card header, so only
// the Branches page has a pill above a card.
// https://github.com/alrayyes/forge-dashboard/issues/4927
// https://github.com/alrayyes/forge-dashboard/issues/828

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const ago = (seconds: number) =>
  new Date(Date.now() - seconds * 1000).toISOString();

async function open(page: Page, width: number, percent: number, age = 12) {
  await page.setViewportSize({ width, height: 844 });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: ago(age),
        forges: [forgeHealth('github')],
        pullRequests: [],
        issues: [],
        repos: [],
        firstRefreshDone: true,
      }),
    }),
  );
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mainBranchPageOf(['passed', 'failed']),
        generatedAt: ago(age),
      }),
    }),
  );
  await page.goto('/');
  await expect(page.locator('.mb-header .live-control')).toBeVisible();
  await expect(page.locator('.mb-bar')).toBeVisible();
  if (percent !== 100)
    await page.addStyleTag({ content: `html { font-size: ${percent}% }` });
}

// The pill's bottom edge to the card's top edge, and the card's own gap to
// the first repo card, which is the gap the pill's must match.
async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (s: string) => {
      const e = document.querySelector(s);
      if (!e) throw new Error(`${s} missing`);
      return e.getBoundingClientRect();
    };
    const bar = document.querySelector('.mb-bar') as HTMLElement;
    const pill = rect('.mb-header .live-control');
    const card = rect('.mb-bar');
    return {
      pillToCard: card.top - pill.bottom,
      cardToList: Number.parseFloat(getComputedStyle(bar).marginBottom),
      scrolls:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    };
  });
}

const STATES = ['live', 'paused', 'stale'] as const;

for (const width of [390, 320]) {
  for (const percent of [100, 175]) {
    for (const state of STATES) {
      test(`${width}px at ${percent}% text, ${state}: the pill and the filter card have a gap`, async ({
        page,
      }) => {
        await open(page, width, percent, state === 'stale' ? 300 : 12);
        const pill = page.locator('.mb-header .live-control');
        if (state === 'paused')
          await pill.getByRole('button', { name: /Pause/ }).click();
        await expect(pill).toContainText(
          state === 'paused' ? 'Paused' : 'Live',
        );
        if (state === 'stale')
          await expect(pill.locator('.live-updated')).toContainText(
            /updated \d+m ago/,
          );
        const m = await measure(page);
        expect(m.cardToList).toBeGreaterThan(0);
        expect(m.pillToCard).toBeGreaterThanOrEqual(m.cardToList);
        expect(m.scrolls).toBe(false);
        const { violations } = await new AxeBuilder({ page })
          .withTags(AXE_TAGS)
          .analyze();
        expect(violations.map((v) => v.id)).toEqual([]);
      });
    }
  }
}
