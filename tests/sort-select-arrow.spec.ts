import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// The sort select's drawn arrow sits in the select's reserved end padding, so
// the "Sorted by Last activity" label never runs under it.
// https://github.com/alrayyes/forge-dashboard/issues/4849

const item = (number: number) => ({
  forge: 'github',
  repo: 'alrayyes/app',
  number,
  title: `Item ${number}`,
  url: `https://example.com/${number}`,
  author: 'ryan',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'mergeable',
});

async function open(
  page: Page,
  path: string,
  width: number,
  scheme: 'light' | 'dark',
  textPercent: number,
) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github', { repoCount: 1 })],
        pullRequests: [item(1), item(2)],
        issues: [item(1), item(2)],
        openIssueCount: 2,
        navCounts: navCountsFor([], 0),
        firstRefreshDone: true,
      }),
    }),
  );
  await page.goto(path);
  await page.addStyleTag({
    content: `html { font-size: ${textPercent}% !important; }`,
  });
}

// The select's text box ends left of where its arrow starts, and the shown
// label fits that box. The arrow is two 5px gradients drawn in the padding.
async function overlap(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const sel of document.querySelectorAll<HTMLSelectElement>(
      '.filter-bar select.group-select',
    )) {
      const r = sel.getBoundingClientRect();
      if (r.width === 0) continue;
      const cs = getComputedStyle(sel);
      const textRight =
        r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
      const textLeft =
        r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      // The first gradient is the chevron's left arm: 5px wide, inset by the
      // calc(100% - Npx) in its background-position.
      const inset = Number(
        /calc\(100% - ([\d.]+)px\)/.exec(cs.backgroundPosition)?.[1] ?? 0,
      );
      const arrowLeft = r.right - inset - 5;
      if (textRight > arrowLeft + 0.5)
        out.push(
          `${sel.id}: text box ends ${textRight} past arrow at ${arrowLeft}`,
        );
      const ctx = document.createElement('canvas').getContext('2d');
      if (ctx) {
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const w = ctx.measureText(sel.selectedOptions[0]?.text ?? '').width;
        if (textLeft + w > arrowLeft + 0.5)
          out.push(
            `${sel.id}: label ends ${textLeft + w} past arrow at ${arrowLeft}`,
          );
      }
    }
    return out;
  });
}

for (const [name, path] of [
  ['pull requests', '/pull-requests.html'],
  ['issues', '/issues.html'],
] as const) {
  for (const width of [320, 390, 768, 1280]) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const text of [100, 175]) {
        test(`${name}: the sort label stays left of its arrow at ${width}px, ${scheme}, ${text}% text (4849)`, async ({
          page,
        }) => {
          await open(page, path, width, scheme, text);
          await expect(page.locator('#pr-sort-select')).toBeVisible();
          await expect.poll(() => overlap(page)).toEqual([]);
          const results = await new AxeBuilder({ page })
            .include('.filter-bar')
            .analyze();
          expect(results.violations).toEqual([]);
        });
      }
    }
  }
}
