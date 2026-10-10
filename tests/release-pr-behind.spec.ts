import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1104: a release-please pull request that falls behind in a repo with
// auto-update-branch on. Auto-update skips it, and release-please only
// rewrites its branch for a new release, so nothing else brings it up to date.
// The server keeps Update branch on the row and tells Merge's "behind" reason
// who does the work. This pins what the row shows for that answer.

const NEXT =
  'Use Update branch. Auto-update skips release-please pull requests, and release-please only rewrites its branch for a new release.';

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `release-behind-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Release Behind');
}

const releasePR = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 1104,
  title: 'chore(main): release 1.2.3',
  url: 'https://example.com/1104',
  author: 'alrayyes',
  draft: false,
  ci: 'success',
  labels: [{ name: 'autorelease: pending', color: 'ededed' }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'blocked',
  behind: true,
  allowedActions: [
    {
      action: 'merge',
      blocked: {
        code: 'behind',
        message: 'Behind the base branch',
        next: NEXT,
      },
    },
    { action: 'close' },
    { action: 'update_branch' },
  ],
};

const snapshot = () =>
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: [releasePR],
    issues: [],
    repos: [],
    hiddenDrafts: 0,
  });

test.describe('a behind release-please pull request (#1104)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('offers Update branch, and Merge says why it is waiting', async ({
    page,
  }) => {
    await page.route('**/api/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: snapshot(),
      }),
    );
    let requestBody: unknown;
    await page.route('**/api/pull-requests/update-branch', (route: Route) => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    const update = row.getByRole('button', { name: 'Update branch' });
    await expect(update).toBeVisible();
    await expect(update).toBeEnabled();
    await expect(update).not.toHaveAttribute('aria-disabled', 'true');

    // Merge stays greyed, and the reason is printed beside it and wired up
    // as its accessible description.
    const merge = row.getByRole('button', { name: 'Merge', exact: true });
    await expect(merge).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText('Behind the base branch');
    await expect(row).toContainText(NEXT);
    await expect(merge).toHaveAccessibleDescription(
      /Behind the base branch.*Use Update branch\./,
    );

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    await update.click();
    await expect.poll(() => requestBody).toBeDefined();
    expect(requestBody).toEqual({
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 1104,
    });
  });
});
