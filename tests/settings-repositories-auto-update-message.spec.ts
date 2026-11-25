import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Auto-update message on Settings, Repositories uses the page's own words
// ("Auto-update turned on for <repo>."), not the forge API's. A bulk run says
// what happened in one summary, and names any repo it couldn't change and why.
// https://github.com/alrayyes/forge-dashboard/issues/4856

const row = (name: string) => ({
  forge: 'github',
  fullName: `example/${name}`,
  hasWebhook: true,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
  rebaseBots: false,
});
const REPOS = ['one', 'two', 'three'].map(row);
const LONG_REASON =
  'the forge refused the change because the branch protection rules on this repository do not allow it';

const SIZES = [
  { name: 'phone', width: 390, height: 800 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;
const SCHEMES = ['light', 'dark'] as const;

async function open(
  page: Page,
  failing: string[] = [],
  repos: ReturnType<typeof row>[] = REPOS,
  reason: string | null = 'the forge refused the change',
) {
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
  await page.route('**/api/v1/repos/auto-update-branch/*', (route: Route) => {
    const { fullName } = route.request().postDataJSON();
    if (failing.includes(fullName))
      return route.fulfill({
        status: 409,
        contentType: reason === null ? 'text/plain' : 'application/json',
        body: reason === null ? 'not json' : JSON.stringify({ error: reason }),
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
          .getByRole('button', { name: 'Turn on auto-update for 3 repos' })
          .click();
        await expect(status(page)).toHaveText(
          'Auto-update turned on for 2 of 3 repos. 1 skipped: example/two (the forge refused the change).',
        );
        await expect(status(page)).toHaveClass(/error/);
        await expectAccessible(page);
      });

      test('a bulk run on one repo names it, with no "all" or "of"', async ({
        page,
      }) => {
        await open(page, [], [row('one')]);
        await page
          .getByRole('button', { name: 'Turn on auto-update for 1 repo' })
          .click();
        await expect(status(page)).toHaveText(
          'Auto-update turned on for example/one.',
        );
      });

      test('a failed bulk run on one repo reads like a single failure', async ({
        page,
      }) => {
        await open(page, ['example/one'], [row('one')]);
        await page
          .getByRole('button', { name: 'Turn on auto-update for 1 repo' })
          .click();
        await expect(status(page)).toHaveText(
          "Couldn't turn auto-update on for example/one: the forge refused the change",
        );
      });

      test('a failure with no message says the server refused, with its status', async ({
        page,
      }) => {
        await open(page, ['example/one'], [row('one')], null);
        await page
          .getByRole('button', { name: 'Turn on auto-update for 1 repo' })
          .click();
        await expect(status(page)).toHaveText(
          "Couldn't turn auto-update on for example/one: the server refused the change (status 409)",
        );
      });

      test('a long reason on one repo is trimmed by code points', async ({
        page,
      }) => {
        await open(
          page,
          ['example/one'],
          [row('one')],
          '\u{1F600}'.repeat(100),
        );
        await page
          .getByRole('button', { name: 'Turn on auto-update for 1 repo' })
          .click();
        await expect(status(page)).toContainText('example/one: ');
        const text = (await status(page).innerText()).trim();
        expect(text).toBe(
          `Couldn't turn auto-update on for example/one: ${'\u{1F600}'.repeat(79)}…`,
        );
        expect(text).not.toMatch(
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
        );
      });

      test('one long unbroken token wraps instead of scrolling', async ({
        page,
      }) => {
        const long = 'x'.repeat(120);
        await open(page, [`example/${long}`], [row(long)], 'refused');
        await page
          .getByRole('button', { name: 'Turn on auto-update for 1 repo' })
          .click();
        await expect(status(page)).toContainText(long);
        const [scroll, client] = await status(page).evaluate((el) => [
          el.scrollWidth,
          el.clientWidth,
        ]);
        expect(scroll).toBeLessThanOrEqual(client);
        // A flex or grid parent that grew with the token would widen the
        // element too, so on a phone also check the page doesn't scroll
        // sideways. (The repo table's own long name widens a desktop page.)
        if (size.name === 'phone') {
          const [docScroll, inner] = await page.evaluate(() => [
            document.documentElement.scrollWidth,
            window.innerWidth,
          ]);
          expect(docScroll).toBeLessThanOrEqual(inner);
        }
      });

      test('many skipped repos are capped, with long reasons trimmed and no sideways scroll', async ({
        page,
      }) => {
        const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `example/${n}`);
        await open(
          page,
          names.slice(0, 5),
          names.map((n) => row(n.slice(8))),
          LONG_REASON,
        );
        await page
          .getByRole('button', { name: 'Turn on auto-update for 5 repos' })
          .click();
        await expect(status(page)).toContainText('0 of 5 repos. 5 skipped:');
        await expect(status(page)).toContainText('and 2 more.');
        await expect(status(page)).not.toContainText('example/d');
        await expect(status(page)).not.toContainText(LONG_REASON);
        await expect(status(page)).toContainText('…)');
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        );
        expect(overflow).toBe(false);
        await expectAccessible(page);
      });

      test('a bulk run that changes everything says so once', async ({
        page,
      }) => {
        await open(page);
        await page
          .getByRole('button', { name: 'Turn on auto-update for 3 repos' })
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
