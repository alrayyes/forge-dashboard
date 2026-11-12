import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// In the Issues and Pull requests filter bar the custom pick triggers
// (repository, authors, labels) and the native selects (Sort, Group,
// Created, Updated) read as one kind of control: same height, type size,
// border, radius and chevron.
// https://github.com/alrayyes/forge-dashboard/issues/3374

// Two repositories, authors and labels, so all three triggers are in the bar:
// a filter with one choice is hidden (#3496).
const item = (number: number, repo: string) => ({
  forge: 'github',
  repo,
  number,
  title: `Item ${number}`,
  url: `https://example.com/${number}`,
  author: number === 1 ? 'ryan' : 'sam',
  draft: false,
  ci: 'success',
  labels: [{ name: number === 1 ? 'docs' : 'bug', color: 'd73a4a' }],
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

  test(`pull requests: no select clips its text in forced colors, ${scheme} (3374)`, async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active', colorScheme: scheme });
    await open(page, '/pull-requests.html', 1280);
    for (const selector of SELECTS) {
      const fit = await page.locator(selector).evaluate((el) => {
        const select = el as HTMLSelectElement;
        const cs = getComputedStyle(select);
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) throw new Error('no canvas');
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const text = select.selectedOptions[0]?.text ?? '';
        // The native arrow takes its own room inside the box, on top of the
        // padding, about 20px in Chromium.
        const arrow = 20;
        const needed =
          ctx.measureText(text).width +
          Number.parseFloat(cs.paddingLeft) +
          Number.parseFloat(cs.paddingRight) +
          arrow;
        return { text, needed, width: select.clientWidth };
      });
      expect(
        fit.needed,
        `${selector} ${JSON.stringify(fit)}`,
      ).toBeLessThanOrEqual(fit.width);
    }
  });
}

// The triggers draw their chevron as a background image, which forced colors
// drops (#3442). They get a border-drawn chevron on ::after instead, which
// forced colors keeps and maps to system colors.
for (const scheme of ['light', 'dark'] as const) {
  for (const [name, path] of [
    ['issues', '/issues.html'],
    ['pull requests', '/pull-requests.html'],
  ] as const) {
    test(`${name}: every pick trigger shows an arrow in forced colors, ${scheme} (3442)`, async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: 'active', colorScheme: scheme });
      await open(page, path, 1280);
      for (const selector of TRIGGERS) {
        const arrow = await page.locator(selector).evaluate((el) => {
          const cs = getComputedStyle(el, '::after');
          return {
            content: cs.content,
            borderBottom: cs.borderBottomWidth,
            borderRight: cs.borderRightWidth,
            borderColor: cs.borderBottomColor,
            text: getComputedStyle(el).color,
          };
        });
        expect(arrow.content, selector).not.toMatch(/^(none|normal)$/);
        expect(Number.parseFloat(arrow.borderBottom), selector).toBeGreaterThan(
          0,
        );
        expect(Number.parseFloat(arrow.borderRight), selector).toBeGreaterThan(
          0,
        );
        // System colors: the arrow takes the trigger's own forced text color.
        expect(arrow.borderColor, selector).toBe(arrow.text);
      }
    });

    test(`${name}: no pick trigger clips its label in forced colors, ${scheme} (3442)`, async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: 'active', colorScheme: scheme });
      await open(page, path, 1280);
      for (const selector of TRIGGERS) {
        const fit = await page.locator(selector).evaluate((el) => {
          const arrow = getComputedStyle(el, '::after');
          const box = el.getBoundingClientRect();
          return {
            textEnd:
              el.clientWidth -
              Number.parseFloat(getComputedStyle(el).paddingRight),
            arrowLeft:
              box.width -
              Number.parseFloat(arrow.right) -
              Number.parseFloat(arrow.width),
          };
        });
        expect(
          fit.textEnd,
          `${selector} ${JSON.stringify(fit)}`,
        ).toBeLessThanOrEqual(fit.arrowLeft);
      }
    });
  }
}

test('pull requests: triggers draw no ::after arrow with forced colors off (3442)', async ({
  page,
}) => {
  await open(page, '/pull-requests.html', 1280);
  for (const selector of TRIGGERS) {
    const content = await page
      .locator(selector)
      .evaluate((el) => getComputedStyle(el, '::after').content);
    expect(content, selector).toMatch(/^(none|normal)$/);
  }
});
