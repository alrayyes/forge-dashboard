import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The Branches filter bar is laid out like the pull request page's: each group
// on a row of its own, then a controls row with the search box and a "Clear
// filters" button that is always there, disabled while nothing is filtered
// (#4612, slice C of #4279). Pressing it returns every group to its default
// and keeps focus in the bar.
// https://github.com/alrayyes/forge-dashboard/issues/4612
// https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html

function branch(name: string, forge: string, status: string) {
  return {
    forge,
    fullName: name,
    url: `https://example.com/${name}`,
    branch: 'main',
    status,
    commit: {
      sha: 'd98f3c2',
      subject: 'fix: a change',
      author: 'dev',
      committedAt: new Date().toISOString(),
    },
    failingJobs: status === 'failed' ? ['lint'] : [],
    finishedAt: new Date().toISOString(),
    durationSeconds: 60,
    runUrl: `https://example.com/${name}/actions/runs/1`,
    staleSince: null,
  };
}

async function open(
  page: Page,
  width = 1280,
  scheme: 'light' | 'dark' = 'light',
) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 800 });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github'), forgeHealth('forgejo')],
        pullRequests: [],
        issues: [],
        repos: [{ forge: 'github', fullName: 'acme/a', hasWebhook: true }],
        firstRefreshDone: true,
      }),
    }),
  );
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {},
        branches: [
          branch('acme/a', 'github', 'passed'),
          branch('acme/b', 'github', 'failed'),
          branch('acme/c', 'forgejo', 'passed'),
        ],
      }),
    }),
  );
  await page.goto('/');
  await expect(page.locator('.mb-bar .filter-pill').first()).toBeVisible();
}

const clear = (page: Page) =>
  page.getByRole('button', { name: 'Clear filters' });

test('the button is there and disabled while nothing is filtered', async ({
  page,
}) => {
  await open(page);
  await expect(clear(page)).toBeVisible();
  // A native disabled button is announced as unavailable by a screen reader.
  await expect(clear(page)).toBeDisabled();
});

test('a status pill, a forge pill or a search enables it', async ({ page }) => {
  await open(page);
  await page
    .locator('.mb-bar')
    .getByRole('button', { name: /^Failing/ })
    .click();
  await expect(clear(page)).toBeEnabled();
  await clear(page).click();
  await expect(clear(page)).toBeDisabled();

  await page
    .getByRole('group', { name: 'Forge' })
    .getByRole('button', { name: /^Forgejo/ })
    .click();
  await expect(clear(page)).toBeEnabled();
  await clear(page).click();

  await page.getByRole('searchbox').fill('acme');
  await expect(clear(page)).toBeEnabled();
});

test('pressing it returns every group to its default and keeps focus in the bar', async ({
  page,
}) => {
  await open(page);
  await page
    .locator('.mb-bar')
    .getByRole('button', { name: /^Failing/ })
    .click();
  await page
    .getByRole('group', { name: 'Forge' })
    .getByRole('button', { name: /^GitHub/ })
    .click();
  await page.getByRole('searchbox').fill('acme');
  await clear(page).focus();
  await clear(page).press('Enter');

  for (const name of ['Status', 'Forge']) {
    await expect(
      page.getByRole('group', { name }).locator('[aria-pressed="true"]'),
    ).toHaveText(/^All\s*3$/);
  }
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await expect(page.getByTestId('main-branch-row')).toHaveCount(3);
  await expect(clear(page)).toBeDisabled();
  // The button turned off under the keyboard: focus moved to a live control in
  // the bar instead of falling to the page.
  const home = await page.evaluate(() => {
    const el = document.activeElement;
    return {
      inBar: !!el?.closest('.mb-bar'),
      tag: el?.tagName,
      disabled: (el as HTMLButtonElement | null)?.disabled,
    };
  });
  expect(home).toEqual({ inBar: true, tag: 'BUTTON', disabled: false });
});

test('the empty state points at the button instead of drawing a second one', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('searchbox').fill('zqxjk');
  await expect(page.getByTestId('no-match')).toContainText('Clear filters');
  await expect(clear(page)).toHaveCount(1);
  await clear(page).click();
  await expect(page.getByTestId('main-branch-row')).toHaveCount(3);
});

test('the bar is laid out like the pull request page: a row per group, then the controls', async ({
  page,
}) => {
  await open(page);
  const rows = await page.evaluate(() => {
    const top = (el: Element | null) => el?.getBoundingClientRect().top ?? -1;
    const bar = document.querySelector('.mb-bar') as HTMLElement;
    const s = getComputedStyle(bar);
    return {
      padding: s.padding,
      radius: s.borderRadius,
      shadow: s.boxShadow !== 'none',
      status: top(bar.querySelector('[aria-labelledby="mb-status-label"]')),
      forge: top(bar.querySelector('[aria-labelledby="mb-forge-label"]')),
      search: top(bar.querySelector('.mb-search')),
      clearTop: top(bar.querySelector('.clear-filters')),
      searchRight: bar.querySelector('.mb-search')?.getBoundingClientRect()
        .right,
      clearLeft: bar.querySelector('.clear-filters')?.getBoundingClientRect()
        .left,
      barRight: bar.getBoundingClientRect().right,
      clearRight: bar.querySelector('.clear-filters')?.getBoundingClientRect()
        .right,
    };
  });
  expect(rows.padding).toBe('12px 18px');
  expect(rows.shadow).toBe(true);
  expect(rows.forge).toBeGreaterThan(rows.status + 30);
  expect(rows.search).toBeGreaterThan(rows.forge + 30);
  // The search and the button share the controls row, the button at the end.
  expect(Math.abs(rows.clearTop - rows.search)).toBeLessThan(20);
  expect(rows.clearLeft).toBeGreaterThan(rows.searchRight ?? 0);
  expect(rows.barRight - (rows.clearRight ?? 0)).toBeLessThan(24);
});

for (const width of [390, 320]) {
  test(`at ${width}px the bar fits with no horizontal scroll and the button is a 44px target`, async ({
    page,
  }) => {
    await open(page, width);
    await page
      .locator('.mb-bar')
      .getByRole('button', { name: /^Failing/ })
      .click();
    const fit = await page.evaluate(() => {
      const root = document.documentElement;
      const bar = document.querySelector('.mb-bar') as HTMLElement;
      const btn = bar.querySelector('.clear-filters') as HTMLElement;
      const search = bar.querySelector('.mb-search') as HTMLElement;
      const b = btn.getBoundingClientRect();
      const s = search.getBoundingClientRect();
      return {
        scrolls: root.scrollWidth > root.clientWidth,
        barScrolls: bar.scrollWidth > bar.clientWidth,
        height: b.height,
        overlap:
          b.left < s.right &&
          b.right > s.left &&
          b.top < s.bottom &&
          b.bottom > s.top,
        inside: b.left >= 0 && b.right <= window.innerWidth,
      };
    });
    expect(fit.scrolls).toBe(false);
    expect(fit.barScrolls).toBe(false);
    expect(fit.height).toBeGreaterThanOrEqual(44);
    expect(fit.overlap).toBe(false);
    expect(fit.inside).toBe(true);
  });
}

test('at 400% text the controls row wraps instead of overflowing', async ({
  page,
}) => {
  await open(page, 320);
  await page.addStyleTag({ content: 'html { font-size: 400% }' });
  // The bar, not the page: the page header's own width at this size is its
  // own matter.
  const wide = await page.evaluate(() =>
    [...document.querySelectorAll('.mb-bar, .mb-bar *')]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
      .map((e) => `${e.tagName}.${e.className}`),
  );
  expect(wide).toEqual([]);
  await expect(clear(page)).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390, 320]) {
    test(`the bar with the button has no axe violations at ${width}px in ${scheme}`, async ({
      page,
    }) => {
      await open(page, width, scheme);
      for (const enabled of [false, true]) {
        if (enabled)
          await page
            .locator('.mb-bar')
            .getByRole('button', { name: /^Failing/ })
            .click();
        const { violations } = await new AxeBuilder({ page })
          .include('.mb-bar')
          .analyze();
        expect(violations.map((v) => v.id)).toEqual([]);
      }
    });
  }
}

test('in forced colours the button keeps its edge and the disabled one is told apart', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await open(page);
  const edge = await clear(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.borderTopStyle, s.borderTopWidth];
  });
  expect(edge).toEqual(['solid', '1px']);
  const off = await clear(page).evaluate((el) => getComputedStyle(el).color);
  await page
    .locator('.mb-bar')
    .getByRole('button', { name: /^Failing/ })
    .click();
  const on = await clear(page).evaluate((el) => getComputedStyle(el).color);
  expect(on).not.toBe(off);
});
