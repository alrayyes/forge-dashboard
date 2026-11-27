import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Repositories filter box gains Auto-update and Rebase bots (All, On, Off),
// the two settings the row toggles change. They AND with the other filters, a
// row toggled out of the filter stays put, and the bulk buttons act on the
// filtered set and say so.
// https://github.com/alrayyes/forge-dashboard/issues/4857

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
  await page.goto('/settings.html#repositories');
  await page.locator('#repositories-rows tr').first().waitFor();
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    test.describe(`${width}px, ${scheme}`, () => {
      const four = () => [
        repo('a', { autoUpdateBranch: true, rebaseBots: true }),
        repo('b', { autoUpdateBranch: true }),
        repo('c', { rebaseBots: true }),
        repo('d'),
      ];
      const pill = (page: Page, group: string, name: string) =>
        page.getByRole('group', { name: group }).getByRole('button', { name });

      test('each filter narrows the list, and they combine', async ({
        page,
      }) => {
        await open(page, width, scheme, four());
        const rows = page.locator('#repositories-rows tr');
        const count = page.locator('#repositories-count');
        await expect(count).toHaveText('Showing all 4 repos');
        await expect(pill(page, 'Auto-update', 'All')).toHaveAttribute(
          'aria-pressed',
          'true',
        );

        await pill(page, 'Auto-update', 'On').click();
        await expect(rows).toHaveText([/owner\/a/, /owner\/b/]);
        await expect(count).toHaveText('Showing 2 of 4 repos');
        await axe(page);

        await pill(page, 'Auto-update', 'Off').click();
        await expect(rows).toHaveText([/owner\/c/, /owner\/d/]);

        await pill(page, 'Auto-update', 'All').click();
        await pill(page, 'Rebase bots', 'On').click();
        await expect(rows).toHaveText([/owner\/a/, /owner\/c/]);

        await pill(page, 'Auto-update', 'On').click();
        await expect(rows).toHaveText([/owner\/a/]);
        await pill(page, 'Rebase bots', 'Off').click();
        await expect(rows).toHaveText([/owner\/b/]);
        await expect(count).toHaveText('Showing 1 of 4 repos');
        // One repo left, so there is nothing to search.
        await expect(page.getByRole('searchbox')).toHaveCount(0);

        await pill(page, 'Rebase bots', 'All').click();
        await page.getByRole('searchbox').fill('zzz');
        await expect(page.locator('#repositories-no-results')).toBeVisible();
        await page.getByRole('button', { name: 'Clear filters' }).click();
        await expect(rows).toHaveCount(4);
        await expect(pill(page, 'Auto-update', 'All')).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await expect(pill(page, 'Rebase bots', 'All')).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await axe(page);
      });

      test('the filters work by keyboard', async ({ page }) => {
        await open(page, width, scheme, four());
        const off = pill(page, 'Rebase bots', 'Off');
        await off.focus();
        await page.keyboard.press('Enter');
        await expect(off).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#repositories-rows tr')).toHaveCount(2);
      });

      test('a row toggled out of the filter stays until the filter changes', async ({
        page,
      }) => {
        await open(page, width, scheme, four());
        await page.route(
          '**/api/v1/repos/auto-update-branch/disable',
          (route) => route.fulfill({ status: 204 }),
        );
        const rows = page.locator('#repositories-rows tr');
        await pill(page, 'Auto-update', 'On').click();
        await expect(rows).toHaveCount(2);

        const toggle = page.getByRole('button', {
          name: 'Auto-update on owner/a',
        });
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
        // It no longer matches, and has not moved or vanished.
        await expect(rows).toHaveText([/owner\/a/, /owner\/b/]);

        await pill(page, 'Auto-update', 'On').click();
        await expect(rows).toHaveText([/owner\/b/]);
      });

      test('a Rebase bots toggle keeps its row the same way', async ({
        page,
      }) => {
        await open(page, width, scheme, four());
        await page.route('**/api/v1/repos/rebase-bots/disable', (route) =>
          route.fulfill({ status: 204 }),
        );
        const rows = page.locator('#repositories-rows tr');
        await pill(page, 'Rebase bots', 'On').click();
        await expect(rows).toHaveText([/owner\/a/, /owner\/c/]);
        await page
          .getByRole('button', { name: 'Rebase bots on owner/a' })
          .click();
        await expect(rows).toHaveText([/owner\/a/, /owner\/c/]);
        await pill(page, 'Rebase bots', 'On').click();
        await expect(rows).toHaveText([/owner\/c/]);
      });

      test('the bulk buttons act on the filtered set and say so', async ({
        page,
      }) => {
        await open(page, width, scheme, four());
        const posts: string[] = [];
        await page.route(
          '**/api/v1/repos/auto-update-branch/enable',
          (route) => {
            posts.push(route.request().postData() ?? '');
            return route.fulfill({ status: 204 });
          },
        );
        const prompts: string[] = [];
        page.on('dialog', (d) => {
          prompts.push(d.message());
          void d.accept();
        });
        // Unfiltered: every repo, worded as before.
        await expect(
          page.getByRole('button', { name: 'Turn on auto-update for 2 repos' }),
        ).toBeVisible();

        await pill(page, 'Rebase bots', 'On').click();
        const bulk = page.getByRole('button', {
          name: 'Turn on auto-update for 1 filtered repo',
        });
        await bulk.click();
        expect(prompts).toEqual(['Turn on auto-update for 1 filtered repo?']);
        await expect.poll(() => posts.length).toBe(1);
        expect(posts[0]).toContain('owner/c');
        // The repo it changed stays in the list under the filter.
        await expect(page.locator('#repositories-rows tr')).toHaveCount(2);
      });
    });
  }
}
