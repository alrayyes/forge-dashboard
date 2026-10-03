import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

// #828: on a phone the filters take a small part of the screen. Closed, the
// bar is one search row and one scrolling row of quick filters, with the
// active filters as removable chips; the rest lives in a bottom sheet (a
// <dialog>). Filters apply as you change them and the sheet's "Show N
// results" button says what you'd see, so a refresh can't disturb an edit.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `mobile-filters-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Mobile Filters');
}

function makePR(number: number, repo: string, author: string) {
  return {
    forge: repo.startsWith('homelab/') ? 'forgejo' : 'github',
    repo,
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author,
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'blocked',
    behind: false,
  };
}

const PRS = [
  makePR(1, 'alrayyes/one', 'ryan'),
  makePR(2, 'alrayyes/two', 'claude'),
  makePR(3, 'alrayyes/two', 'ryan'),
  makePR(4, 'homelab/three', 'claude'),
  makePR(5, 'homelab/three', 'ryan'),
];

function snapshot() {
  return {
    generatedAt: new Date().toISOString(),
    forges: [
      { forge: 'github', reachable: true, repoCount: 2 },
      { forge: 'forgejo', reachable: true, repoCount: 1 },
    ],
    pullRequests: PRS,
    issues: [],
    repos: [],
    hiddenDrafts: 0,
  };
}

async function open(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __streams: EventSource[];
      EventSource: typeof EventSource;
    };
    w.__streams = [];
    const Real = w.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        w.__streams.push(this);
      }
    };
  });
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot()),
    }),
  );
  await page.goto('/');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(5);
}

const filtersButton = (page: Page) =>
  page.getByRole('button', { name: /^Filters/ });
const sheet = (page: Page) => page.locator('dialog#filter-sheet');

for (const size of [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
]) {
  test.describe(`mobile filters at ${size.width}x${size.height} (#828)`, () => {
    test.beforeEach(async ({ page, request, baseURL }) => {
      await registerAndSignIn(page, request, baseURL);
      await open(page, size);
    });

    test('the first pull request row is on the first screen and the closed filter area is small', async ({
      page,
    }) => {
      const first = await page.locator('#pr-rows > .row').first().boundingBox();
      expect(first).not.toBeNull();
      // Visible without scrolling: its top is well inside the viewport.
      expect(first?.y ?? 9999).toBeLessThan(size.height - 60);

      const bar = await page.locator('.filter-bar').boundingBox();
      expect(bar?.height ?? 9999).toBeLessThanOrEqual(150);
    });

    test('closed, it is a search row and one scrolling row of quick filters, with no forge pills', async ({
      page,
    }) => {
      const bar = page.locator('.filter-bar');
      await expect(
        bar.getByRole('combobox', { name: 'Filter by title' }),
      ).toBeVisible();
      await expect(filtersButton(page)).toBeVisible();
      await expect(filtersButton(page)).toHaveAttribute(
        'aria-expanded',
        'false',
      );

      const pills = page.locator('.quick-pills');
      const box = await pills.boundingBox();
      expect(box?.height ?? 9999).toBeLessThanOrEqual(48);
      await expect(
        bar.getByRole('button', { name: 'Failing CI' }),
      ).toBeVisible();
      // The forge control moved into the sheet.
      await expect(
        page.locator('.quick-pills').getByRole('button', { name: 'GitHub' }),
      ).toBeHidden();
    });

    test('Filters opens a bottom sheet with the other controls, and Escape closes it and returns focus', async ({
      page,
    }) => {
      await filtersButton(page).click();

      await expect(sheet(page)).toBeVisible();
      await expect(filtersButton(page)).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      for (const name of [
        'Filter by repo',
        'Filter by author',
        'Filter by label',
        'Filter by created',
        'Filter by updated',
        'Group rows by',
      ]) {
        await expect(sheet(page).getByLabel(name)).toBeVisible();
      }
      await expect(
        sheet(page).getByRole('button', { name: 'GitHub' }),
      ).toBeVisible();
      await expect(
        sheet(page).getByRole('button', { name: /^Show \d+ results?$/ }),
      ).toBeVisible();
      await expect(
        sheet(page).getByRole('button', { name: 'Clear all' }),
      ).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(sheet(page)).toBeHidden();
      await expect(filtersButton(page)).toBeFocused();
      await expect(filtersButton(page)).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });

    test('changing a filter in the sheet narrows the results and updates the count and the button', async ({
      page,
    }) => {
      await filtersButton(page).click();
      await sheet(page).getByLabel('Filter by repo').selectOption({
        label: 'alrayyes/two',
      });

      await expect(
        sheet(page).getByRole('button', { name: 'Show 2 results' }),
      ).toBeVisible();
      await sheet(page).getByRole('button', { name: 'Show 2 results' }).click();
      await expect(sheet(page)).toBeHidden();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
      await expect(filtersButton(page)).toHaveText(/Filters \(1\)/);
      await expect(filtersButton(page)).toBeFocused();
    });

    test('an active filter shows as a removable chip with a 44px target, without opening the sheet', async ({
      page,
    }) => {
      await filtersButton(page).click();
      await sheet(page).getByLabel('Filter by author').selectOption('claude');
      await page.keyboard.press('Escape');

      const chip = page.getByRole('button', {
        name: /^Remove filter: Author claude/,
      });
      await expect(chip).toBeVisible();
      const box = await chip.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

      await chip.click();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(5);
      await expect(filtersButton(page)).toHaveText(/^Filters$/);
      await expect(chip).toHaveCount(0);
    });

    test('Clear all resets the filters', async ({ page }) => {
      await filtersButton(page).click();
      await sheet(page).getByLabel('Filter by repo').selectOption({
        label: 'homelab/three',
      });
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

      await sheet(page).getByRole('button', { name: 'Clear all' }).click();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(5);
      await expect(
        sheet(page).getByRole('button', { name: 'Clear all' }),
      ).toBeDisabled();
    });

    test('a refresh does not change a filter being edited in the sheet', async ({
      page,
    }) => {
      await filtersButton(page).click();
      await sheet(page).getByLabel('Filter by repo').selectOption({
        label: 'alrayyes/two',
      });

      await page.evaluate((data) => {
        const w = window as unknown as { __streams: EventSource[] };
        for (const stream of w.__streams)
          stream.onmessage?.(new MessageEvent('message', { data }));
      }, JSON.stringify(snapshot()));
      await page.waitForTimeout(400);

      await expect(sheet(page)).toBeVisible();
      await expect(sheet(page).getByLabel('Filter by repo')).toHaveValue(
        'github:alrayyes/two',
      );
    });

    for (const state of ['closed', 'open'] as const) {
      test(`has no axe violations with the sheet ${state}`, async ({
        page,
      }) => {
        if (state === 'open') await filtersButton(page).click();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  });
}

test.describe('the desktop filter bar is unchanged (#828)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    await open(page, { width: 1280, height: 800 });
  });

  test('no Filters button, no sheet, every control in the bar', async ({
    page,
  }) => {
    await expect(filtersButton(page)).toBeHidden();
    await expect(page.getByLabel('Filter by repo')).toBeVisible();
    await expect(
      page.locator('.quick-pills').getByRole('button', { name: 'GitHub' }),
    ).toBeVisible();
    await expect(page.locator('#active-filters')).toBeHidden();
  });
});
