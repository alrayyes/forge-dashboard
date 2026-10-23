import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A pick saved by an earlier build that no longer fits the limits is cut as
// the page loads. The page now says what was dropped, once.
// https://github.com/alrayyes/forge-dashboard/issues/2558

async function open(page: Page, baseURL: string | undefined, labels: string[]) {
  const value = JSON.stringify({
    shared: { label: labels.join('\n') },
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

const toasts = (page: Page) => page.locator('#feedback-toasts');

test('names the labels a saved pick lost', async ({ page, baseURL }) => {
  await open(
    page,
    baseURL,
    Array.from({ length: 22 }, (_, i) => `label-${i}`),
  );
  await expect(toasts(page)).toContainText('label-20, label-21');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('says nothing when the saved pick fits', async ({ page, baseURL }) => {
  await open(page, baseURL, ['bug', 'docs']);
  await expect(page.locator('#issue-rows')).toBeAttached();
  await expect(toasts(page)).not.toContainText('dropped');
});
