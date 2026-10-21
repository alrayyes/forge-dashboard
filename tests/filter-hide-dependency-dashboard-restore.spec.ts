import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The page's own "Hide Dependency Dashboard" checkbox has to come back the way
// it was left, from the cookie and, on a browser without the cookie, from the
// saved copy on the server. The saved state is per user, so each test
// registers its own.
// https://github.com/alrayyes/forge-dashboard/issues/1620

const now = () => new Date().toISOString();
const ISSUES = [
  {
    forge: 'github',
    repo: 'acme/app',
    number: 1,
    title: 'Dependency Dashboard',
    url: 'https://example.com/issues/1',
    author: 'renovate[bot]',
    labels: [],
    housekeeping: true,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    forge: 'github',
    repo: 'acme/app',
    number: 2,
    title: 'A real issue',
    url: 'https://example.com/issues/2',
    author: 'ryan',
    labels: [],
    createdAt: now(),
    updatedAt: now(),
  },
];

async function open(page: Page, url: string) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
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
  await page.goto(url);
}

const checkbox = (page: Page) =>
  page.locator('#issue-hide-dependency-dashboard');
// What the page lists for the box: Issues rows, or Insights' newest-age count.
const listed = (page: Page, label: string) =>
  label === 'Issues'
    ? page.locator('#issue-rows > .row')
    : page.locator('#issue-age-chart [data-age-bucket="lt1"] .age-count');
const listedValue = (on: boolean, label: string) =>
  label === 'Issues' ? (on ? 1 : 2) : on ? '1' : '2';

const nav = (page: Page, name: string) =>
  page.locator(`.app-nav a[href="/${name}.html"]`);

const savedValue = async (page: Page) =>
  (await (await page.request.get('/api/settings/filter-state')).json())?.issue
    ?.hideDependencyDashboard;

// A browser that has never been here: the session stays, the cookie goes.
async function dropFilterCookie(page: Page) {
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: no Cookie Store API in every browser.
    document.cookie = 'forge-board-filters=; path=/; max-age=0';
  });
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    'forge-board-filters',
  );
}

async function expectList(page: Page, label: string, hidden: boolean) {
  const where = listed(page, label);
  const want = listedValue(hidden, label);
  if (typeof want === 'number') await expect(where).toHaveCount(want);
  else await expect(where).toHaveText(want);
}

for (const [label, path] of [
  ['Issues', '/issues.html'],
  ['Insights', '/insights.html'],
] as const) {
  test.describe(`${label}: Hide Dependency Dashboard is restored`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, path);
      await expect(checkbox(page)).toBeChecked();
      await expectList(page, label, true);
      await checkbox(page).uncheck();
      await expect.poll(() => savedValue(page)).toBe('');
    });

    test('is still off after leaving the page and coming back', async ({
      page,
    }) => {
      await nav(page, 'pull-requests').click();
      await nav(page, label === 'Issues' ? 'issues' : 'insights').click();
      await expect(checkbox(page)).not.toBeChecked();
    });

    test('is still off on a browser with the server copy only', async ({
      page,
    }) => {
      await dropFilterCookie(page);
      await page.reload();
      await expect(checkbox(page)).not.toBeChecked();
      await expectList(page, label, false);
      await checkbox(page).check();
      await expectList(page, label, true);
    });
  });
}
