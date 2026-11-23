import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// A clear button and Escape for the title or number box. Both empty only that
// box; the other filters stay as they are (#4077).
// https://github.com/alrayyes/forge-dashboard/issues/4077

function pr(number: number, forge: 'github' | 'forgejo') {
  return {
    forge,
    repo: forge === 'github' ? 'acme/app' : 'acme/tool',
    number,
    title: `Change ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'sam',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    closesIssues: [],
    refsIssues: [],
    mentionsIssues: [],
  };
}

const ROWS = [
  pr(1, 'github'),
  pr(2, 'github'),
  pr(3, 'forgejo'),
  pr(4, 'forgejo'),
];

async function open(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github'), forgeHealth('forgejo')],
        pullRequests: ROWS,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row').first()).toBeVisible();
}

const search = (page: Page) => page.locator('#title-filter');
const clear = (page: Page) =>
  page.getByRole('button', { name: 'Clear title filter' });
const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
const rows = (page: Page) => page.locator('#pr-rows > .row');

const VIEWPORTS = [
  { name: 'phone', width: 360, height: 780 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`title box clear at ${vp.width}px (#4077)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });
    const phone = vp.name === 'phone';

    test('AC1: no clear button while the box is empty, one with text', async ({
      page,
    }) => {
      await open(page);
      await expect(clear(page)).toHaveCount(0);
      await expect(page.locator('.search-hint')).toBeVisible();
      await search(page).fill('Change 3');
      await expect(clear(page)).toBeVisible();
      await expect(page.locator('.search-hint')).toBeHidden();
      await search(page).fill('');
      await expect(clear(page)).toHaveCount(0);
    });

    test('AC2: click empties the box, keeps focus, restores the rows', async ({
      page,
    }) => {
      await open(page);
      await search(page).fill('Change 3');
      await expect(rows(page)).toHaveCount(1);
      await clear(page).click();
      await expect(search(page)).toHaveValue('');
      await expect(search(page)).toBeFocused();
      await expect(rows(page)).toHaveCount(4);
      await expect(page.locator('#filter-sheet-count')).toHaveText('4 results');
      await expect(clear(page)).toHaveCount(0);
    });

    test('AC3: Escape empties the box; on an empty box it does nothing', async ({
      page,
    }) => {
      await open(page);
      await search(page).fill('Change 3');
      await expect(rows(page)).toHaveCount(1);
      await search(page).press('Escape');
      await expect(search(page)).toHaveValue('');
      await expect(search(page)).toBeFocused();
      await expect(rows(page)).toHaveCount(4);
      const prevented = await search(page).evaluate((el) => {
        const e = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      });
      expect(prevented).toBe(false);
    });

    test('keyboard: the button is the next tab stop and Enter clears', async ({
      page,
    }) => {
      await open(page);
      await search(page).fill('Change');
      await search(page).press('Tab');
      await expect(clear(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(search(page)).toHaveValue('');
      await expect(search(page)).toBeFocused();
    });

    test('other filters stay set when the box is cleared', async ({ page }) => {
      await open(page);
      if (phone) {
        await page.getByRole('button', { name: /^Filters/ }).click();
        await page
          .locator('dialog#filter-sheet')
          .getByRole('button', { name: /^Forgejo( \d+)?$/ })
          .click();
        await page.keyboard.press('Escape');
      } else {
        await page
          .locator('.filter-bar')
          .getByRole('button', { name: /^Forgejo( \d+)?$/ })
          .click();
      }
      await expect(rows(page)).toHaveCount(2);
      await search(page).fill('Change 3');
      await expect(rows(page)).toHaveCount(1);
      await clear(page).click();
      await expect(rows(page)).toHaveCount(2);
      await expect(rows(page).first()).toContainText('Change 3');
      await expect(rows(page).last()).toContainText('Change 4');
    });

    test('AC5: the button does not move the box or cover the Filters button', async ({
      page,
    }) => {
      const box = async (loc: Locator) => {
        const b = await loc.boundingBox();
        if (!b) throw new Error('not drawn');
        return b;
      };
      await open(page);
      const before = await box(search(page));
      await search(page).fill('Change');
      const s = await box(search(page));
      expect(s).toEqual(before);
      const b = await box(clear(page));
      expect(b.x).toBeGreaterThanOrEqual(s.x);
      expect(b.x + b.width).toBeLessThanOrEqual(s.x + s.width + 0.5);
      if (phone) {
        const f = await box(page.locator('#filters-button'));
        expect(b.x + b.width).toBeLessThanOrEqual(f.x);
        expect(b.height).toBeGreaterThanOrEqual(44);
      } else {
        expect(b.height).toBeGreaterThanOrEqual(24);
        expect(b.width).toBeGreaterThanOrEqual(24);
      }
    });

    for (const mode of ['light', 'dark'] as const) {
      test(`AC4: axe is clean with and without text in ${mode}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: mode });
        await open(page);
        expect((await axe(page)).violations).toEqual([]);
        await search(page).fill('Change');
        await expect(clear(page)).toBeVisible();
        expect((await axe(page)).violations).toEqual([]);
        await clear(page).focus();
        await expect(clear(page)).toBeFocused();
        expect((await axe(page)).violations).toEqual([]);
      });
    }
  });
}
