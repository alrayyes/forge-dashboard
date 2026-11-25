import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Auto-update message on Settings, Repositories uses the page's own words
// ("Auto-update turned on for <repo>."), not the forge API's. A bulk run says
// what happened in one summary, and names any repo it couldn't change and why.
// https://github.com/alrayyes/forge-dashboard/issues/4856

const REPOS = ['one', 'two', 'three'].map((name) => ({
  forge: 'github',
  fullName: `example/${name}`,
  hasWebhook: true,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
  rebaseBots: false,
}));

const SIZES = [
  { name: 'phone', width: 390, height: 800 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;
const SCHEMES = ['light', 'dark'] as const;

async function open(page: Page, failing: string[] = []) {
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
        repos: REPOS,
      }),
    }),
  );
  await page.route('**/api/v1/repos/auto-update-branch/*', (route: Route) => {
    const { fullName } = route.request().postDataJSON();
    if (failing.includes(fullName))
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'the forge refused the change' }),
      });
    return route.fulfill({ status: 204 });
  });
  page.on('dialog', (d) => void d.accept());
  await page.goto('/settings.html#repositories');
  await expect(page.locator('#repositories-rows tr').first()).toBeVisible();
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const status = (page: Page) => page.locator('#repositories-status');

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test.describe(`auto-update message, ${size.name}, ${scheme}`, () => {
      test.use({
        viewport: { width: size.width, height: size.height },
        colorScheme: scheme,
      });

      test('toggling one row says on, then off, in the page words', async ({
        page,
      }) => {
        await open(page);
        const toggle = page.getByRole('button', {
          name: 'Auto-update on example/one',
        });
        await toggle.click();
        await expect(status(page)).toHaveText(
          'Auto-update turned on for example/one.',
        );
        await expectAccessible(page);
        await toggle.click();
        await expect(status(page)).toHaveText(
          'Auto-update turned off for example/one.',
        );
        await expect(status(page)).not.toContainText(/auto-update-branch/i);
      });

      test('a bulk run with one repo that cannot change gives one summary', async ({
        page,
      }) => {
        await open(page, ['example/two']);
        await page
          .getByRole('button', { name: 'Enable auto-update for 3 repos' })
          .click();
        await expect(status(page)).toHaveText(
          'Auto-update turned on for 2 of 3 repos. 1 skipped: example/two (the forge refused the change).',
        );
        await expect(status(page)).toHaveClass(/error/);
        await expectAccessible(page);
      });

      test('a bulk run that changes everything says so once', async ({
        page,
      }) => {
        await open(page);
        await page
          .getByRole('button', { name: 'Enable auto-update for 3 repos' })
          .click();
        await expect(status(page)).toHaveText(
          'Auto-update turned on for all 3 repos.',
        );
        await expect(status(page)).not.toHaveClass(/error/);
      });
    });
  }
}

test('the message is a polite live region', async ({ page }) => {
  await open(page);
  await expect(status(page)).toHaveAttribute('role', 'status');
  await expect(status(page)).toHaveAttribute('aria-live', 'polite');
});
