import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// Three full picks and a long multibyte title together pass what a browser
// keeps in one cookie, and it would drop the whole cookie without a word. The
// page cuts the cookie on purpose and says what it left out.
// https://github.com/alrayyes/forge-dashboard/issues/2619

const names = (prefix: string) =>
  Array.from(
    { length: 20 },
    (_, i) => `${prefix}-${String(i).padStart(2, '0')}-${'x'.repeat(28)}`,
  ).join('\n');

async function open(page: Page, baseURL: string | undefined) {
  const value = JSON.stringify({
    shared: {
      label: names('label'),
      repo: names('repo'),
      author: names('who'),
    },
    rev: 1,
  });
  await page.context().addCookies([
    {
      name: 'forge-board-filters',
      value: encodeURIComponent(value),
      url: baseURL ?? '',
    },
  ]);
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/issues.html');
}

const notice = (page: Page) => page.locator('#filter-cookie-trimmed');

test('names what a cookie too large for the browser left out', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await expect(page.locator('#issue-rows')).toBeAttached();
  await expect(notice(page)).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Filter by title' })
    .fill('漢'.repeat(200));
  await expect(notice(page)).toContainText('the title search');
  const size = await page.evaluate(
    () =>
      document.cookie.split('; ').find((c) => c.startsWith('forge-board-'))
        ?.length ?? 0,
  );
  expect(size).toBeGreaterThan(0);
  expect(size).toBeLessThanOrEqual(3800);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
