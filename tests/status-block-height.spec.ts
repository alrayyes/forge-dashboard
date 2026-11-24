import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// On a list narrower than the one-line row (761px to 1190px) the status block
// of a behind, draft or conflicting pull request was as wide as the whole
// status cell and its text wrapped in the cell's width, so the block was
// taller than its words need. It now takes the height of its text and the fix
// button's 30px target and no more.
// https://github.com/alrayyes/forge-dashboard/issues/4600

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
  pr(1, { title: 'Plain' }),
  pr(2, { title: 'Behind', mergeStatus: 'blocked', behind: true }),
  pr(3, { title: 'Draft', draft: true }),
  pr(4, { title: 'Conflicting', mergeStatus: 'conflicting' }),
];

async function open(page: Page, width: number) {
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
        pullRequests: PRS,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const rowFor = (page: Page, title: string) =>
  page.locator('#pr-rows > .row').filter({
    has: page.locator('.title-text', { hasText: new RegExp(`${title}$`) }),
  });

// The row's list is narrower than the one-line layout from 761px to 1190px of
// list width, which is a viewport of 761px up to about 1190px plus the page's
// gutters. 1000px is the audit's measurement.
for (const width of [800, 1000]) {
  test.describe(`status block height at ${width}px (#4600)`, () => {
    for (const title of ['Behind', 'Draft', 'Conflicting']) {
      test(`${title}: the block is its text, its fix button and 4px above and below, no more`, async ({
        page,
      }) => {
        await open(page, width);
        const area = rowFor(page, title).locator('.status-area');
        await expect(area).toHaveCount(1);
        const m = await area.evaluate((el) => {
          const text = el.querySelector('.status-area-text') as HTMLElement;
          const fix = el.querySelector(
            '.status-area-fix',
          ) as HTMLElement | null;
          const lines = Array.from(
            text.querySelectorAll('.status-area-message, .status-area-next'),
          ).reduce((sum, n) => sum + n.getBoundingClientRect().height, 0);
          return {
            block: el.getBoundingClientRect().height,
            words: lines,
            fix: fix ? fix.getBoundingClientRect().height : 0,
          };
        });
        // Words and button, with 4px of padding above and below and nothing
        // between them.
        expect(m.block).toBeLessThanOrEqual(m.words + m.fix + 8 + 0.5);
      });
    }

    test('the fix button keeps its 30px target and the block its icon and words', async ({
      page,
    }) => {
      await open(page, width);
      const area = rowFor(page, 'Behind').locator('.status-area');
      await expect(area.locator('svg')).toHaveCount(1);
      await expect(area).toContainText('Behind the base branch');
      const btn = await area
        .getByRole('button', { name: 'Update branch' })
        .boundingBox();
      expect(btn!.height).toBeGreaterThanOrEqual(30);
    });
  });
}

test('the phone card keeps its block padding (#4600)', async ({ page }) => {
  await open(page, 390);
  const pad = await rowFor(page, 'Behind')
    .locator('.status-area')
    .evaluate((el) => getComputedStyle(el).paddingTop);
  expect(pad).toBe('6px');
});

for (const [label, emulate] of [
  ['light', { colorScheme: 'light' }],
  ['dark', { colorScheme: 'dark' }],
  ['forced colors', { forcedColors: 'active' }],
] as const) {
  test(`axe finds nothing on the status blocks in ${label} (#4600)`, async ({
    page,
  }) => {
    await page.emulateMedia(emulate);
    await open(page, 1000);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
