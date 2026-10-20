import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1427: the Created and Updated ranges and the forge
// buttons offer only choices that exist in the results, like the repo, author
// and label selects do.
// https://github.com/alrayyes/forge-dashboard/issues/1427

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `static-choices-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Static Choices');
}

const ago = (hours: number) =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: ago(48),
    updatedAt: ago(48),
    mergeStatus: 'mergeable',
    allowedActions: [{ action: 'merge' }, { action: 'close' }],
    ...overrides,
  };
}

async function open(page: Page, path: string, pullRequests: unknown[]) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(path);
}

const values = (page: Page, selector: string) =>
  page
    .locator(`${selector} option`)
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));

const CREATED = 'select[data-col="created"]';
const UPDATED = 'select[data-col="updated"]';

test.describe('age choices on the pull request page (#1427)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('offer only the age ranges something falls in', async ({ page }) => {
    await open(page, '/pull-requests.html', [
      pr(1, { ci: 'success', createdAt: ago(48), updatedAt: ago(2) }),
      pr(2, { ci: 'failure', createdAt: ago(72), updatedAt: ago(30) }),
    ]);
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

    // Created 48h and 72h ago: nothing is under an hour or a day old.
    expect(await values(page, CREATED)).toEqual(['', '10080', '43200']);
    // Updated 2h and 30h ago.
    expect(await values(page, UPDATED)).toEqual(['', '1440', '10080', '43200']);
  });

  test('a quick pill narrows the age ranges too', async ({ page }) => {
    await open(page, '/pull-requests.html', [
      pr(1, { ci: 'success', createdAt: ago(0.5) }),
      pr(2, { ci: 'failure', createdAt: ago(48) }),
    ]);
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    expect(await values(page, CREATED)).toContain('60');

    await page.getByRole('button', { name: 'Failing CI' }).click();

    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    expect(await values(page, CREATED)).toEqual(['', '10080', '43200']);
  });

  test('has no axe-core violations with the narrowed choices', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html', [
      pr(1, { ci: 'success' }),
      pr(2, { ci: 'failure' }),
    ]);
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    await page.selectOption('#shared-author-select', 'claude');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('forge buttons on Insights (#1427)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  const forgeLabel = (page: Page, value: string) =>
    page.locator(
      `.filter-bar label:has(input[data-col="forge"][value="${value}"])`,
    );

  test('a forge with nothing to chart is not offered', async ({ page }) => {
    await open(page, '/insights.html', [pr(1)]);
    await expect(forgeLabel(page, 'github')).toBeVisible();
    await expect(forgeLabel(page, 'forgejo')).toBeHidden();
  });

  test('picking a repo narrows the forge buttons to the forge it is on', async ({
    page,
  }) => {
    await open(page, '/insights.html', [
      pr(1),
      pr(2, { forge: 'forgejo', repo: 'ryan/infra' }),
    ]);
    await expect(forgeLabel(page, 'forgejo')).toBeVisible();

    await page.selectOption('#shared-repo-select', 'github:alrayyes/app');

    await expect(forgeLabel(page, 'github')).toBeVisible();
    await expect(forgeLabel(page, 'forgejo')).toBeHidden();
  });

  test('a forge you picked stays offered after a reload that finds nothing on it', async ({
    page,
  }) => {
    await open(page, '/insights.html', [
      pr(1),
      pr(2, { forge: 'forgejo', repo: 'ryan/infra' }),
    ]);
    // The saved pick has to reach the server before the page reloads.
    const saved = page.waitForResponse(
      (r) =>
        r.url().includes('/api/settings/filter-state') &&
        r.request().method() !== 'GET',
    );
    await forgeLabel(page, 'forgejo').click();
    await expect(
      page.locator('.filter-bar input[value="forgejo"]'),
    ).toBeChecked();
    await saved;
    await page.unroute('**/api/dashboard*');
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [pr(1)],
          issues: [],
          openIssueCount: 0,
          repos: [],
          hiddenDrafts: 0,
        }),
      }),
    );
    await page.reload();

    await expect(forgeLabel(page, 'github')).toBeVisible();
    await expect(forgeLabel(page, 'forgejo')).toBeVisible();
    await expect(
      page.locator('.filter-bar input[value="forgejo"]'),
    ).toBeChecked();
  });

  test('both are offered when both forges have pull requests', async ({
    page,
  }) => {
    await open(page, '/insights.html', [
      pr(1),
      pr(2, { forge: 'forgejo', repo: 'ryan/infra' }),
    ]);
    await expect(forgeLabel(page, 'github')).toBeVisible();
    await expect(forgeLabel(page, 'forgejo')).toBeVisible();
  });
});
