import { expect, type Route } from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1593: the title pattern belongs to the Issues board. Insights shares the
// saved filter state but has no box for it, so its charts must not hide
// anything because of it.

function issue(number: number, title: string) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://example.com/issues/${number}`,
    author: 'ryan',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test('a saved title pattern does not change the Insights issue counts', async ({
  page,
  request,
  baseURL,
}) => {
  await registerViaInvite(
    page,
    request,
    baseURL,
    `insights-hide-title-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    'Insights Hide Title',
  );
  const saved = await page.request.put('/api/settings/filter-state', {
    data: {
      shared: {},
      pr: {},
      issue: { hideDependencyDashboard: '1', hideTitleRegex: '^Weekly' },
      view: {},
    },
  });
  expect(saved.ok()).toBe(true);
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [
          issue(1, 'Fix the login page'),
          issue(2, 'Weekly report 1'),
          issue(3, 'Weekly report 2'),
        ],
      }),
    }),
  );

  await page.goto('/insights.html');

  const rows = page.locator('#repo-issue-ranking .rank-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.rank-count')).toHaveText('3');
});
