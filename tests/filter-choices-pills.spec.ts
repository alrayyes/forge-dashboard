import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1427: a quick pill is offered only when clicking it would show something,
// like every other filter choice. The one that is active stays, so it can be
// seen and cleared.
// https://github.com/alrayyes/forge-dashboard/issues/1427

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `pill-choices-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Pill Choices');
}

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
    ...overrides,
  };
}

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: 'ryan',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function serve(
  page: Page,
  pullRequests: unknown[],
  issues: unknown[] = [],
) {
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues,
        openIssueCount: issues.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

async function open(
  page: Page,
  path: string,
  pullRequests: unknown[],
  issues: unknown[] = [],
) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await serve(page, pullRequests, issues);
  await page.goto(path);
}

const pill = (page: Page, name: string) =>
  page
    .getByRole('group', { name: 'Quick filters' })
    .getByRole('button', { name, exact: true });

test.describe('quick pills offer only what would show something (#1427)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('only the pills some pull request matches are offered', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html', [
      pr(1, { ci: 'success', readyToMerge: true }),
      pr(2, { ci: 'failure' }),
    ]);
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

    for (const name of ['All', 'GitHub', 'Failing CI', 'Ready to Merge']) {
      await expect(pill(page, name)).toBeVisible();
    }
    for (const name of [
      'Forgejo',
      'Conflicts',
      'Needs Review',
      'Review requested from me',
    ]) {
      await expect(pill(page, name)).toBeHidden();
    }
  });

  test('the pills follow the CI filter', async ({ page }) => {
    await open(page, '/pull-requests.html', [
      pr(1, { ci: 'success', readyToMerge: true }),
      pr(2, { ci: 'failure' }),
    ]);
    await expect(pill(page, 'Failing CI')).toBeVisible();

    await page.selectOption('select[data-col="status"]', 'success');

    await expect(pill(page, 'Failing CI')).toBeHidden();
    await expect(pill(page, 'Ready to Merge')).toBeVisible();
  });

  test('the active pill stays offered after a reload that finds nothing for it', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html', [
      pr(1, { ci: 'success' }),
      pr(2, { ci: 'failure' }),
    ]);
    const saved = page.waitForResponse(
      (r) =>
        r.url().includes('/api/settings/filter-state') &&
        r.request().method() !== 'GET',
    );
    await pill(page, 'Failing CI').click();
    await saved;

    await page.unroute('**/api/dashboard*');
    await serve(page, [pr(1, { ci: 'success' })]);
    await page.reload();

    await expect(pill(page, 'Failing CI')).toBeVisible();
    await expect(pill(page, 'Failing CI')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(pill(page, 'All')).toBeVisible();
  });

  test('the Issues page offers only the forges its issues are on', async ({
    page,
  }) => {
    await open(page, '/issues.html', [], [issue(1)]);

    await expect(pill(page, 'All')).toBeVisible();
    await expect(pill(page, 'GitHub')).toBeVisible();
    await expect(pill(page, 'Forgejo')).toBeHidden();
  });

  test('has no axe-core violations with pills hidden', async ({ page }) => {
    await open(page, '/pull-requests.html', [pr(1, { ci: 'failure' })]);
    await expect(pill(page, 'Failing CI')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
