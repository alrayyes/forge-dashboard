import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// Settings, Repositories draws Clear filters as the shared bordered button, in
// the bar beside the filter controls and not inside the search field.
// https://github.com/alrayyes/forge-dashboard/issues/5066

const repo = (name: string, autoUpdateBranch = false) => ({
  forge: 'github',
  fullName: `owner/${name}`,
  url: `https://example.test/owner/${name}`,
  hasWebhook: true,
  canManageWebhooks: true,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch,
  rebaseBots: false,
});

// One repository differs, so the Auto-update pills are offered.
const mixed = [repo('a', true), repo('b'), repo('c')];
// One forge and equal toggles: no pill group, only the search box.
const alike = [repo('a'), repo('b'), repo('c')];

async function open(
  page: Page,
  width: number,
  scheme: 'light' | 'dark',
  repos = mixed,
) {
  await page.setViewportSize({ width, height: 800 });
  await page.emulateMedia({ colorScheme: scheme });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos,
      }),
    }),
  );
  await page.goto('/settings.html#repositories');
  await page.locator('#repositories-count').waitFor();
}

const clearButton = (page: Page) =>
  page.getByRole('button', { name: 'Clear filters' });

// Leaves two rows, so the search box and the button are both drawn.
const filterToTwo = (page: Page) =>
  page
    .getByRole('group', { name: 'Auto-update', exact: true })
    .getByRole('button', { name: 'Off', exact: true })
    .click();

const look = (button: Locator) =>
  button.evaluate((el) => {
    const s = getComputedStyle(el);
    return [
      s.borderTopWidth,
      s.borderTopStyle,
      s.borderTopColor,
      s.borderTopLeftRadius,
      s.backgroundColor,
      s.color,
      s.fontFamily,
      s.fontSize,
      s.paddingTop,
      s.paddingLeft,
      s.textDecorationLine,
      s.position,
      `${el.getBoundingClientRect().height}`,
    ];
  });

const ring = (button: Locator) =>
  button.evaluate((el: HTMLElement) => {
    // `focusVisible` draws the ring after a pointer click too; TypeScript's
    // DOM types don't list it yet.
    el.focus({ focusVisible: true } as FocusOptions);
    const s = getComputedStyle(el);
    return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.outlineOffset];
  });

const focusedOnBody = (page: Page) =>
  page.evaluate(() => document.activeElement === document.body);

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    test.describe(`${width}px, ${scheme}`, () => {
      test('is the shared button, beside the filter controls', async ({
        page,
      }) => {
        await open(page, width, scheme);
        await filterToTwo(page);
        const clear = clearButton(page);
        // The same class on a bare element, with nothing of this page on it.
        await page.evaluate(() => {
          const plain = document.createElement('button');
          plain.id = 'plain-clear';
          plain.className = 'clear-filters';
          plain.textContent = 'Reference';
          document.body.append(plain);
        });
        const plain = page.locator('#plain-clear');
        expect(await look(clear)).toEqual(await look(plain));
        const shared = await ring(plain);
        expect(shared[0]).toBe('solid');
        expect(await ring(clear)).toEqual(shared);
        await page.locator('#plain-clear').evaluate((el) => el.remove());

        await expect(page.locator('.search-field .clear-filters')).toHaveCount(
          0,
        );
        const search = page.getByRole('searchbox');
        expect(
          await search.evaluate((el) => {
            const s = getComputedStyle(el);
            return s.paddingRight === s.paddingLeft;
          }),
        ).toBe(true);

        const button = await clear.boundingBox();
        const box = await search.boundingBox();
        if (!button || !box) throw new Error('not laid out');
        const apart =
          button.x >= box.x + box.width || button.y >= box.y + box.height;
        expect(apart).toBe(true);
        // At the end of the bar, not wherever the wrap happens to leave it.
        const barEnd = await page.locator('.filter-bar').evaluate((el) => {
          const s = getComputedStyle(el);
          return (
            el.getBoundingClientRect().right -
            Number.parseFloat(s.borderRightWidth) -
            Number.parseFloat(s.paddingRight)
          );
        });
        expect(Math.abs(button.x + button.width - barEnd)).toBeLessThan(1);
        if (width === 390) expect(button.height).toBeGreaterThanOrEqual(44);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(0);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });

      test('clearing with the pointer leaves focus off the body', async ({
        page,
      }) => {
        await open(page, width, scheme);
        await filterToTwo(page);
        await clearButton(page).click();
        await expect(clearButton(page)).toHaveCount(0);
        await expect.poll(() => focusedOnBody(page)).toBe(false);
        // Not the search box, which would raise a phone's keyboard.
        await expect(page.getByRole('searchbox')).not.toBeFocused();
      });

      test('clearing with the keyboard goes to the search box', async ({
        page,
      }) => {
        await open(page, width, scheme);
        await filterToTwo(page);
        await clearButton(page).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('searchbox')).toBeFocused();
      });
    });
  }
}

for (const width of [390, 1280]) {
  // With no pill to take it, focus must still pass the search box by.
  test(`${width}px, search only: a pointer clear skips the search box`, async ({
    page,
  }) => {
    await open(page, width, 'light', alike);
    const search = page.getByRole('searchbox');
    await search.fill('a');
    await expect(page.locator('.filter-pill')).toHaveCount(0);
    await clearButton(page).click();
    await expect(clearButton(page)).toHaveCount(0);
    await expect.poll(() => focusedOnBody(page)).toBe(false);
    await expect(search).not.toBeFocused();
  });
}
