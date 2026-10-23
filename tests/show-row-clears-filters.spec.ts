import { expect, type Page, type Route } from '@playwright/test';
import { pickedValues, pickOnly } from './label-filter-helper';
import { test } from './server-fixture';

// Show row on a pull request that the CI pill or auto-merge filter hides
// has to clear that filter where the page keeps it (the pull-request group),
// leave the filters that do not hide the row alone, and save the result.

function pr(number: number, ci: string, autoMergeEnabled: boolean) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci,
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    autoMergeEnabled,
  };
}

// 1 is the one the test acts on; 2 is what keeps the filter meaningful.
const PRS = [pr(1, 'success', false), pr(2, 'failure', true)];

async function open(page: Page) {
  await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowBotPrUpdates: false }),
    }),
  );
  await page.route('**/api/pull-requests/update-branch', (route: Route) =>
    route.fulfill({ status: 202 }),
  );
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: PRS,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
}

const titles = (page: Page) => page.locator('#pr-rows > .row .title-text');

// Queues an action on pull request 1 so Activity has an entry for it.
async function queueOnFirst(page: Page) {
  await page
    .locator('#pr-rows .row', { hasText: /Pull request 1(?!\d)/ })
    .getByRole('button', { name: 'Update branch' })
    .click();
  await expect(page.locator('#activity-toggle')).toContainText('Activity 1');
}

async function filtersByAuthor(page: Page) {
  await pickOnly(page, 'author', 'github:claude');
}

async function showRow(page: Page) {
  await page.locator('#activity-toggle').click();
  await page
    .locator('#activity-panel .activity-item')
    .first()
    .getByRole('button', { name: 'Show row' })
    .click();
}

async function savedCopies(page: Page) {
  const cookie = await page.evaluate(() => {
    const m = document.cookie.match(/forge-board-filters=([^;]*)/);
    return m ? JSON.parse(decodeURIComponent(m[1])) : null;
  });
  const res = await page.request.get('/api/settings/filter-state');
  return { cookie, server: await res.json() };
}

test.describe('Show row clears the filter that hides the row', () => {
  test('the Failing CI pill', async ({ page }) => {
    await open(page);
    await queueOnFirst(page);
    await filtersByAuthor(page);
    await page.locator('.quick-pills [data-pill="failing"]').click();
    await expect(titles(page)).toHaveCount(1);
    await expect(titles(page).first()).toContainText('Pull request 2');

    await showRow(page);

    await expect(
      page.locator('.quick-pills [data-pill="all"]'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(titles(page)).toHaveCount(2);
    // Only what hid the row is cleared.
    await expect
      .poll(() => pickedValues(page, 'author'))
      .toEqual(['github:claude']);
    await expect(async () => {
      const { cookie, server } = await savedCopies(page);
      expect(cookie?.pr?.quick || '').toBe('');
      expect(server?.pr?.quick || '').toBe('');
      expect(cookie?.shared?.author).toBe('github:claude');
      expect(server?.shared?.author).toBe('github:claude');
    }).toPass();
  });

  test('the auto-merge filter', async ({ page }) => {
    await open(page);
    await queueOnFirst(page);
    await filtersByAuthor(page);
    await page.locator('.filter-bar > .am-group [data-am="on"]').click();
    await expect(titles(page)).toHaveCount(1);
    await expect(titles(page).first()).toContainText('Pull request 2');

    await showRow(page);

    await expect(titles(page)).toHaveCount(2);
    await expect(
      page.locator('.filter-bar > .am-group [data-am="any"]'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => pickedValues(page, 'author'))
      .toEqual(['github:claude']);
    await expect(async () => {
      const { cookie, server } = await savedCopies(page);
      expect(cookie?.pr?.autoMerge || '').toBe('');
      expect(server?.pr?.autoMerge || '').toBe('');
      expect(cookie?.shared?.author).toBe('github:claude');
      expect(server?.shared?.author).toBe('github:claude');
    }).toPass();
  });
});
