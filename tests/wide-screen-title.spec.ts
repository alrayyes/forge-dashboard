import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The column stayed 1220px on a wide monitor, so a pull request title was cut
// to about 25 characters beside 2000px of empty margin. Above about 1356px the
// column grows with the viewport (90vw) up to 1800px, and the extra width goes
// to the 1fr title track. The cap is 1800px so a 3440px screen keeps a line
// length a row can be scanned across.
// https://github.com/alrayyes/forge-dashboard/issues/4540

const TITLE = 'feat(api): add a retry budget to the webhook delivery queue';

const PR = {
  forge: 'github',
  repo: 'example-org/api',
  number: 1,
  title: TITLE,
  url: 'https://example.com/pull/1',
  author: 'demo-user',
  draft: false,
  ci: 'success',
  checks: { passed: 8, skipped: 0, running: 0, waiting: 0, failed: 0 },
  labels: [],
  createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  updatedAt: new Date(Date.now() - 1000).toISOString(),
  mergeStatus: 'mergeable',
  behind: false,
  reviewComments: 0,
  unresolvedThreads: 0,
};

async function open(page: Page, width: number, path = '/pull-requests.html') {
  await page.setViewportSize({ width, height: 900 });
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
        pullRequests: [PR],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(path);
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector('#pr-rows > .row') as HTMLElement;
    const text = row.querySelector('.title-text') as HTMLElement;
    return {
      wrap: document.querySelector('.wrap')?.getBoundingClientRect().width ?? 0,
      title:
        row.querySelector('.title-cell')?.getBoundingClientRect().width ?? 0,
      rowHeight: row.getBoundingClientRect().height,
      truncated: text.scrollWidth > text.clientWidth,
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    };
  });
}

test('the column and the title grow above 1400px, to a cap', async ({
  page,
}) => {
  await open(page, 1280);
  const base = await measure(page);
  expect(base.wrap).toBe(1220);
  const seen: Record<number, Awaited<ReturnType<typeof measure>>> = {};
  for (const width of [1920, 2560, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    seen[width] = await measure(page);
    expect(seen[width].title).toBeGreaterThan(base.title);
    expect(seen[width].rowHeight).toBeLessThanOrEqual(base.rowHeight);
    expect(seen[width].scroll).toBeLessThanOrEqual(seen[width].client);
  }
  expect(seen[1920].wrap).toBeGreaterThan(1220);
  expect(seen[1920].wrap).toBe(Math.round(1920 * 0.9 * 100) / 100);
  expect(seen[2560].wrap).toBe(1800);
  expect(seen[3440].wrap).toBe(1800);
});

test('a 50 to 70 character title shows in full at 1920px', async ({ page }) => {
  await open(page, 1920);
  expect((await measure(page)).truncated).toBe(false);
});

test('the column is unchanged at 1220px and below', async ({ page }) => {
  for (const width of [1220, 1100, 800, 390]) {
    await open(page, width);
    const m = await measure(page);
    expect(m.wrap).toBeLessThanOrEqual(Math.min(1220, width));
    expect(m.scroll).toBeLessThanOrEqual(m.client);
  }
});

test('the Issues board and the Branches page use the same width', async ({
  page,
}) => {
  await open(page, 2560);
  const pr = (await measure(page)).wrap;
  for (const path of ['/issues.html', '/']) {
    await page.goto(path);
    const w = await page.evaluate(
      () =>
        (
          document.querySelector('.wrap, .mb-wrap') as HTMLElement
        ).getBoundingClientRect().width,
    );
    expect(w).toBe(pr);
  }
});

test('the whole title is in the row at 1920px (hover text is title-hover-text.spec.ts)', async ({
  page,
}) => {
  await open(page, 1920);
  const link = page.locator('#pr-rows > .row .title-text').first();
  await expect(link).toContainText(TITLE);
});

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1920, 2560]) {
    test(`no axe violations in ${scheme} at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, width);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
