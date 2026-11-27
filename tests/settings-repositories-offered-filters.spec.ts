import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Repositories filter box draws only what can change the list, the way the
// other pages' filter bars do. Which choices those are is unit tested in
// web/src/lib/repositories.test.ts; this is the page doing it.
// https://github.com/alrayyes/forge-dashboard/issues/5065

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  forge: 'github',
  fullName: `owner/${name}`,
  url: `https://example.test/owner/${name}`,
  hasWebhook: true,
  canManageWebhooks: true,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
  rebaseBots: false,
  ...extra,
});

async function open(
  page: Page,
  width: number,
  scheme: 'light' | 'dark',
  repos: Record<string, unknown>[],
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
  await page.route('**/api/v1/repos/**', (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.goto('/settings.html#repositories');
  await page.locator('#repositories-count').waitFor();
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const group = (page: Page, name: string) =>
  page.getByRole('group', { name, exact: true });
const pill = (page: Page, groupName: string, name: string) =>
  group(page, groupName).getByRole('button', { name, exact: true });
const onBody = (page: Page) =>
  page.evaluate(() => document.activeElement === document.body);

// A control's distance from the top of the viewport.
const top = async (control: Locator) =>
  (await control.boundingBox())?.y ?? Number.NaN;
// A scroll lands on whole pixels, so a pixel either way is not a jump.
async function expectUnmoved(control: Locator, before: number) {
  expect(Math.abs((await top(control)) - before)).toBeLessThanOrEqual(1);
}

const four = (extra: Record<string, unknown> = {}) => [
  repo('a', extra),
  repo('b'),
  repo('c'),
  repo('d'),
];

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    test.describe(`${width}px, ${scheme}`, () => {
      test('draws no group that cannot change the list', async ({ page }) => {
        await open(page, width, scheme, [repo('a'), repo('b')]);
        for (const name of ['Forge', 'Ignored', 'Auto-update', 'Rebase bots']) {
          await expect(group(page, name)).toHaveCount(0);
          await expect(
            page.locator('.filter-bar').getByText(name, { exact: true }),
          ).toHaveCount(0);
        }
        await expect(page.getByRole('searchbox')).toBeVisible();
        await axe(page);
      });

      test('groups follow a toggled row, which stays put', async ({ page }) => {
        await open(page, width, scheme, [repo('a'), repo('b')]);
        const rows = page.locator('#repositories-rows tr');
        const toggle = page.getByRole('button', {
          name: 'Auto-update on owner/a',
        });

        await toggle.click();
        await expect(pill(page, 'Auto-update', 'On')).toBeVisible();
        await expect(pill(page, 'Auto-update', 'Off')).toBeVisible();
        await expect(group(page, 'Rebase bots')).toHaveCount(0);
        await axe(page);

        await toggle.click();
        await expect(group(page, 'Auto-update')).toHaveCount(0);
        await expect(rows).toHaveText([/owner\/a/, /owner\/b/]);
      });

      test('a group that goes with its own pick leaves focus on a control', async ({
        page,
      }) => {
        await open(page, width, scheme, [
          repo('a', { autoUpdateBranch: true }),
          repo('b'),
        ]);
        await pill(page, 'Auto-update', 'Off').click();
        // The only row left is switched on, so every repo agrees.
        await page
          .getByRole('button', { name: 'Auto-update on owner/b' })
          .click();
        // The pick keeps the group, to be undone.
        const all = pill(page, 'Auto-update', 'All');
        await expect(pill(page, 'Auto-update', 'Off')).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await all.focus();
        await page.keyboard.press('Enter');
        await expect(group(page, 'Auto-update')).toHaveCount(0);
        await expect(page.getByRole('searchbox')).toBeFocused();
        expect(await onBody(page)).toBe(false);
      });

      test('the toggled control stays where it is as a group comes and goes', async ({
        page,
      }) => {
        await open(page, width, scheme, four());
        const toggle = page.getByRole('button', {
          name: 'Rebase bots on owner/b',
        });
        await toggle.scrollIntoViewIfNeeded();
        const before = await top(toggle);

        await toggle.click();
        await expect(group(page, 'Rebase bots')).toBeVisible();
        await expectUnmoved(toggle, before);

        await toggle.click();
        await expect(group(page, 'Rebase bots')).toHaveCount(0);
        await expectUnmoved(toggle, before);
      });

      test('it stays put when a group goes from a page not yet scrolled', async ({
        page,
      }) => {
        await open(page, width, scheme, four({ rebaseBots: true }));
        const toggle = page.getByRole('button', {
          name: 'Rebase bots on owner/a',
        });
        // A phone has to scroll to reach the first card; a desktop does not.
        await toggle.scrollIntoViewIfNeeded();
        const before = await top(toggle);

        await toggle.click();
        await expect(group(page, 'Rebase bots')).toHaveCount(0);
        await expectUnmoved(toggle, before);
        await axe(page);

        // The room made for it goes with the next filter change.
        await page.getByRole('searchbox').fill('owner');
        await expect(page.getByTestId('held-room')).toHaveCount(0);
      });

      test('the Ignore menu stays where it is as its group appears', async ({
        page,
      }) => {
        await open(page, width, scheme, four());
        const menu = page.getByRole('combobox', { name: /owner\/b/ });
        await menu.scrollIntoViewIfNeeded();
        const before = await top(menu);

        await menu.selectOption('prs');
        await expect(group(page, 'Ignored')).toBeVisible();
        await expectUnmoved(menu, before);
      });

      test('the search box stays while a toggled row is still listed', async ({
        page,
      }) => {
        await open(page, width, scheme, [
          repo('a'),
          repo('b'),
          repo('c', { autoUpdateBranch: true }),
        ]);
        await pill(page, 'Auto-update', 'Off').click();
        await page
          .getByRole('button', { name: 'Auto-update on owner/a' })
          .click();
        await expect(page.locator('#repositories-count')).toContainText('2');
        await expect(page.locator('#repositories-rows tr')).toHaveCount(2);
        await expect(page.getByRole('searchbox')).toBeVisible();
      });

      test('focus from a group that goes lands on a pressed pill', async ({
        page,
      }) => {
        await open(page, width, scheme, [
          repo('a', { autoUpdateBranch: true }),
          repo('b', { forge: 'gitlab', autoUpdateBranch: true }),
          repo('c', { forge: 'gitlab' }),
        ]);
        await pill(page, 'Auto-update', 'Off').click();
        await page
          .getByRole('button', { name: 'Auto-update on owner/c' })
          .click();
        await pill(page, 'Auto-update', 'All').focus();
        await page.keyboard.press('Enter');
        await expect(group(page, 'Auto-update')).toHaveCount(0);
        await expect(pill(page, 'Forge', 'All')).toBeFocused();
      });

      test('focus from a bar that goes lands on the first row', async ({
        page,
      }) => {
        await open(page, width, scheme, [
          repo('a', { ignored: true, ignoredPRs: true }),
        ]);
        await pill(page, 'Ignored', 'Show').click();
        await page.getByRole('combobox', { name: /owner\/a/ }).selectOption('');
        await expect(page.locator('#repositories-status')).toContainText(
          'no longer ignored',
        );
        await pill(page, 'Ignored', 'Hide').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.filter-bar')).toHaveCount(0);
        await expect(
          page.locator('#repositories-rows a').first(),
        ).toBeFocused();
        expect(await onBody(page)).toBe(false);
      });

      test('Clear filters works over one row, with no search box', async ({
        page,
      }) => {
        await open(page, width, scheme, [
          repo('a', { autoUpdateBranch: true }),
          repo('b'),
        ]);
        await pill(page, 'Auto-update', 'On').click();
        await expect(page.getByRole('searchbox')).toHaveCount(0);
        await axe(page);
        const clear = page.getByRole('button', { name: 'Clear filters' });
        await clear.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#repositories-rows tr')).toHaveCount(2);
        await expect(page.getByRole('searchbox')).toBeFocused();
      });

      test('one repo has no filter bar', async ({ page }) => {
        await open(page, width, scheme, [repo('a')]);
        await expect(page.locator('.filter-bar')).toHaveCount(0);
        await axe(page);
      });

      test('one ignored repo keeps the way to see it', async ({ page }) => {
        await open(page, width, scheme, [
          repo('a', { ignored: true, ignoredPRs: true }),
        ]);
        await pill(page, 'Ignored', 'Show').click();
        await expect(page.locator('#repositories-rows tr')).toHaveCount(1);
      });
    });
  }
}
