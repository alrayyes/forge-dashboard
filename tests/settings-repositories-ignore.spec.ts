import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// Ignore on a repo row flips in place, like Auto-update and Rebase bots: the
// row stays where it is and says what is ignored in words. The separate
// "Ignored (N)" list is gone; Ignored is a filter on the same list.
// https://github.com/alrayyes/forge-dashboard/issues/4854

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
      test('Ignore flips in place, says the scope in words, and flips back', async ({
        page,
      }) => {
        await open(page, width, scheme, [repo('a'), repo('b'), repo('c')]);
        const posts: string[] = [];
        await page.route('**/api/v1/repos/{ignore,unignore}', (route) => {
          posts.push(new URL(route.request().url()).pathname);
          return route.fulfill({ status: 204 });
        });
        const rows = page.locator('#repositories-rows tr');
        const select = page.getByRole('combobox', { name: 'Ignore owner/b' });
        const gap = async () =>
          (await rows.nth(1).boundingBox())!.y -
          (await rows.first().boundingBox())!.y;
        const before = await gap();
        const heightBefore = (await rows.nth(1).boundingBox())!.height;

        await select.selectOption('prs');
        await expect(rows.nth(1)).toContainText('Ignored: pull requests');
        await expect(select).toHaveValue('prs');
        await expect(select).toHaveAttribute('data-ignored', 'true');
        await expect(rows).toHaveText([/owner\/a/, /owner\/b/, /owner\/c/]);
        await expect(page.locator('#repositories-status')).toContainText(
          'owner/b is now ignored',
        );
        // The row keeps its place in the list and is never shorter.
        expect(await gap()).toBe(before);
        expect(
          (await rows.nth(1).boundingBox())!.height,
        ).toBeGreaterThanOrEqual(heightBefore);
        await expect(page.locator('#repositories-ignored')).toHaveCount(0);
        await axe(page);

        // Another scope is reachable from the row, in place.
        await select.selectOption('both');
        await expect(rows.nth(1)).toContainText(
          'Ignored: pull requests and issues',
        );

        await select.selectOption('');
        await expect(rows.nth(1)).not.toContainText('Ignored:');
        await expect(select).not.toHaveAttribute('data-ignored', 'true');
        await expect(rows).toHaveCount(3);
        expect(posts).toEqual([
          '/api/v1/repos/ignore',
          '/api/v1/repos/ignore',
          '/api/v1/repos/unignore',
        ]);
        await axe(page);
      });

      test('the Ignored filter hides, shows or isolates ignored repos', async ({
        page,
      }) => {
        await open(page, width, scheme, [
          repo('a'),
          repo('b', { ignored: true, ignoredIssues: true }),
        ]);
        const rows = page.locator('#repositories-rows tr');
        const group = page.getByRole('group', { name: 'Ignored' });
        const pill = (name: string) => group.getByRole('button', { name });

        // The default keeps today's view: ignored repos are hidden.
        await expect(pill('Hide')).toHaveAttribute('aria-pressed', 'true');
        await expect(rows).toHaveText([/owner\/a/]);

        await pill('Show').click();
        await expect(pill('Show')).toHaveAttribute('aria-pressed', 'true');
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(1)).toContainText('Ignored: issues');
        await expect(
          rows.nth(1).getByRole('combobox', { name: 'Ignore owner/b' }),
        ).toHaveValue('issues');
        await axe(page);

        await pill('Only').click();
        await expect(rows).toHaveText([/owner\/b/]);

        await page.getByRole('button', { name: 'Clear filters' }).click();
        await expect(pill('Hide')).toHaveAttribute('aria-pressed', 'true');
        await expect(rows).toHaveText([/owner\/a/]);
      });

      test('a repo just ignored stays visible until the filter changes', async ({
        page,
      }) => {
        await open(page, width, scheme, [repo('a'), repo('b')]);
        await page.route('**/api/v1/repos/ignore', (route) =>
          route.fulfill({ status: 204 }),
        );
        const rows = page.locator('#repositories-rows tr');
        await page
          .getByRole('combobox', { name: 'Ignore owner/a' })
          .selectOption('both');
        // The default view hides ignored repos, yet the row stays to undo.
        await expect(rows).toHaveCount(2);
        await expect(rows.first()).toContainText('Ignored:');

        const group = page.getByRole('group', { name: 'Ignored' });
        await group.getByRole('button', { name: 'Show' }).click();
        await group.getByRole('button', { name: 'Hide' }).click();
        await expect(rows).toHaveText([/owner\/b/]);
      });
    });
  }
}
