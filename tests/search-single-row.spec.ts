import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The title search hides when the other filters leave exactly one row, since
// it has nothing to narrow (#3823). It never hides while it holds text. The
// decision is unit-tested in search-offer.test.ts; this is the wiring.
// https://github.com/alrayyes/forge-dashboard/issues/3823

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

const TWO = [pr(1, 'github'), pr(2, 'forgejo')];

async function open(page: Page, live: () => unknown[] = () => TWO) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [
          { forge: 'github', reachable: true, repoCount: 1 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests: live(),
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
const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

// Picks the Forgejo forge: in the bar on a desktop, in the Filters sheet on a
// phone.
async function pickForgejo(page: Page, phone: boolean) {
  if (!phone) {
    await page
      .locator('.filter-bar')
      .getByRole('button', { name: 'Forgejo', exact: true })
      .click();
    return;
  }
  await page.getByRole('button', { name: /^Filters/ }).click();
  const sheet = page.locator('dialog#filter-sheet');
  await sheet.getByRole('button', { name: 'Forgejo', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
}

const VIEWPORTS = [
  { name: 'phone', width: 360, height: 780 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`title search over one row at ${vp.width}px (#3823)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });
    const phone = vp.name === 'phone';

    test('AC1: one row left by the other filters hides the empty search', async ({
      page,
    }) => {
      await open(page);
      await expect(search(page)).toBeVisible();
      await pickForgejo(page, phone);
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(search(page)).toBeHidden();
    });

    test('AC2: two rows keep the search', async ({ page }) => {
      await open(page);
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
      await expect(search(page)).toBeVisible();
    });

    test('AC3: a search holding text stays over one row', async ({ page }) => {
      await open(page);
      await search(page).fill('Change');
      await pickForgejo(page, phone);
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(search(page)).toBeVisible();
      await expect(search(page)).toHaveValue('Change');
    });

    test('AC3: text that narrows two rows to one does not hide the box', async ({
      page,
    }) => {
      await open(page);
      await search(page).fill('Change 2');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(search(page)).toBeVisible();
      await search(page).fill('');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
      await expect(search(page)).toBeVisible();
    });

    test('AC4: a focused search that hides hands focus to a control still drawn', async ({
      page,
    }) => {
      await open(page);
      await search(page).fill('Change');
      await pickForgejo(page, phone);
      await expect(search(page)).toBeVisible();
      // Emptying the box over one row hides it under the cursor.
      await search(page).focus();
      await search(page).fill('');
      await expect(search(page)).toBeHidden();
      const held = await page.evaluate(() => {
        const el = document.activeElement;
        return {
          drawn:
            el !== null &&
            el !== document.body &&
            el.getClientRects().length > 0,
          inBar: !!el?.closest('.filter-bar'),
        };
      });
      expect(held).toEqual({ drawn: true, inBar: true });
      // No gap: the bar's first row is still as tall as its content.
      const top = await page.locator('.filter-bar-top').boundingBox();
      if (phone) expect(top?.height ?? 0).toBeGreaterThan(30);
    });

    test('AC5: clearing the filter brings the search back without a reload', async ({
      page,
    }) => {
      await open(page);
      await pickForgejo(page, phone);
      await expect(search(page)).toBeHidden();
      if (phone) await page.getByRole('button', { name: /^Filters/ }).click();
      await page
        .locator(phone ? '#filter-sheet-clear' : '#clear-filters-button')
        .click();
      if (phone) await page.keyboard.press('Escape');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
      await expect(search(page)).toBeVisible();
    });

    for (const mode of ['light', 'dark', 'forced-colors'] as const) {
      test(`AC5: axe is clean over one row in ${mode}`, async ({ page }) => {
        if (mode === 'forced-colors')
          await page.emulateMedia({ forcedColors: 'active' });
        else await page.emulateMedia({ colorScheme: mode });
        await open(page);
        await pickForgejo(page, phone);
        await expect(search(page)).toBeHidden();
        expect((await axe(page)).violations).toEqual([]);
      });
    }
  });
}
