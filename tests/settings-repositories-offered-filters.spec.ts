import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
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
