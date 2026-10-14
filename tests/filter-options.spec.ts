import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1427: a filter offers only choices that exist in the results the page can
// show. On the Issues page a repo whose only issue is Renovate's hidden
// Dependency Dashboard has nothing to show, so it isn't a choice until the
// "Hide Dependency Dashboard" box is unticked.
// https://github.com/alrayyes/forge-dashboard/issues/1427

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `filter-options-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Filter Options');
}

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: 'ryan',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// alrayyes/app has a real issue. alrayyes/dash-only has nothing but the
// Dependency Dashboard, which the page hides by default, and that issue is
// the only one by renovate and the only one labelled "dependencies".
const ISSUES = [
  issue(1),
  issue(2, { author: 'claude', labels: [{ name: 'enhancement' }] }),
  issue(3, {
    repo: 'alrayyes/dash-only',
    title: 'Dependency Dashboard',
    author: 'renovate',
    labels: [{ name: 'dependencies', color: '0366d6' }],
    housekeeping: true,
  }),
];

async function open(page: Page, path: string) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
        pullRequests: [],
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(path);
}

const choices = (page: Page, id: string) =>
  page
    .locator(`#${id} option`)
    .evaluateAll((os) =>
      os.map((o) => (o as HTMLOptionElement).textContent?.trim() ?? ''),
    );

for (const path of ['/issues.html', '/insights.html']) {
  test.describe(`filter choices on ${path} (#1427)`, () => {
    test.beforeEach(async ({ page, request, baseURL }) => {
      await registerAndSignIn(page, request, baseURL);
      await open(page, path);
    });

    test('offer only repos, authors and labels the page can show', async ({
      page,
    }) => {
      await expect(page.locator('#shared-repo-select option')).toHaveCount(2);

      expect(await choices(page, 'shared-repo-select')).toEqual([
        'All repos',
        'alrayyes/app',
      ]);
      expect(await choices(page, 'shared-author-select')).toEqual([
        'All authors',
        'claude',
        'ryan',
      ]);
      expect(await choices(page, 'shared-label-select')).toEqual([
        'All labels',
        'bug',
        'enhancement',
      ]);
    });

    test('unticking Hide Dependency Dashboard makes what it hid a choice, and ticking it again takes it away', async ({
      page,
    }) => {
      const hide = page.locator('#issue-hide-dependency-dashboard');
      await expect(page.locator('#shared-repo-select option')).toHaveCount(2);

      await hide.uncheck();
      await expect(page.locator('#shared-repo-select option')).toHaveCount(3);
      expect(await choices(page, 'shared-repo-select')).toContain(
        'alrayyes/dash-only',
      );
      expect(await choices(page, 'shared-author-select')).toContain('renovate');
      expect(await choices(page, 'shared-label-select')).toContain(
        'dependencies',
      );

      await hide.check();
      await expect(page.locator('#shared-repo-select option')).toHaveCount(2);
      expect(await choices(page, 'shared-author-select')).not.toContain(
        'renovate',
      );
    });
  });
}
