import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// In the Issues and Pull requests filter bar the custom pick triggers
// (repository, authors, labels) and the native selects (Sort, Group,
// Created, Updated) read as one kind of control: same height, type size,
// border, radius and chevron.
// https://github.com/alrayyes/forge-dashboard/issues/3374

const item = (number: number, repo: string) => ({
  forge: 'github',
  repo,
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

async function open(page: Page, path: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
        pullRequests: [item(1, 'alrayyes/app'), item(2, 'alrayyes/api')],
        issues: [item(1, 'alrayyes/app'), item(2, 'alrayyes/api')],
        openIssueCount: 2,
        navCounts: navCountsFor([], 0),
        firstRefreshDone: true,
      }),
    }),
  );
  await page.goto(path);
  await expect(page.locator('#shared-repo-filter-button')).toBeVisible();
}

const TRIGGERS = [
  '#shared-repo-filter-button',
  '#shared-author-filter-button',
  '#shared-label-filter-button',
];
const SELECTS = [
  '#pr-sort-select',
  '#shared-group-select',
  'select[data-col="created"]',
  'select[data-col="updated"]',
];

async function look(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      height: Math.round(r.height * 10) / 10,
      fontSize: cs.fontSize,
      borderColor: cs.borderTopColor,
      borderWidth: cs.borderTopWidth,
      radius: cs.borderTopLeftRadius,
      chevron: cs.backgroundImage,
      chevronPosition: cs.backgroundPosition,
      chevronSize: cs.backgroundSize,
    };
  });
}

for (const [name, path] of [
  ['issues', '/issues.html'],
  ['pull requests', '/pull-requests.html'],
] as const) {
  for (const width of [1280, 1440, 1950]) {
    test(`${name}: pick triggers and native selects look alike at ${width}px (3374)`, async ({
      page,
    }) => {
      await open(page, path, width);
      const reference = await look(page, TRIGGERS[0]);
      expect(reference.chevron).not.toBe('none');
      for (const selector of [...TRIGGERS.slice(1), ...SELECTS]) {
        expect(await look(page, selector), selector).toEqual(reference);
      }
    });
  }
}

// Forced colors strips the drawn chevron's background image, so a select that
// opted out of its native arrow would be left with no dropdown affordance.
// Each select must show an arrow of some kind: the drawn one or the native one.
for (const scheme of ['light', 'dark'] as const) {
  test(`pull requests: every select keeps a dropdown arrow in forced colors, ${scheme} (3374)`, async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active', colorScheme: scheme });
    await open(page, '/pull-requests.html', 1280);
    for (const selector of SELECTS) {
      const shown = await page.locator(selector).evaluate((el) => ({
        appearance: getComputedStyle(el).appearance,
        chevron: getComputedStyle(el).backgroundImage,
      }));
      const hasArrow =
        shown.appearance !== 'none' || !/^none(, none)*$/.test(shown.chevron);
      expect(hasArrow, `${selector} ${JSON.stringify(shown)}`).toBe(true);
    }
  });
}
