import { expect, type Page, type Route } from '@playwright/test';
import { pickOnly, toggleLabels } from './label-filter-helper';
import { test } from './server-fixture';

// A filter save the server turns away used to vanish without a word. The page
// now says the filter was not saved, once, and does not send it again by
// itself. The saved state is on the server, so this spec registers its own.
// https://github.com/alrayyes/forge-dashboard/issues/2100

const ISSUES = [
  {
    forge: 'github',
    repo: 'acme/app',
    number: 1,
    title: 'Issue 1',
    url: 'https://example.com/issues/1',
    author: 'ryan',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

async function open(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/issues.html');
}

test('a refused filter save is reported on the page', async ({ page }) => {
  await open(page);
  await expect(page.locator('#issue-rows > .row')).toHaveCount(1);

  await page.route('**/api/v1/settings/filter-state', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    return route.fulfill({ status: 400, body: '{"error":"too many labels"}' });
  });

  await pickOnly(page, 'author', 'github:ryan');
  await expect(page.locator('#filter-save-refused')).toBeVisible();
  await expect(page.locator('#filter-save-refused')).toContainText('not saved');
});
