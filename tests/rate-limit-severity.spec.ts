import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

// #806: the banner reads each rate limit's `severity` from the server, and a
// locked action offers Retry from the refusal's `code`, not from the words in
// its message. The mocks below state `severity` and `code` so they disagree
// with what the page used to work out itself.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `rate-limit-severity-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Severity');
}

const FUTURE = () => new Date(Date.now() + 20 * 60_000).toISOString();

async function open(
  page: Page,
  health: Record<string, unknown>,
  prs: Record<string, unknown>[] = [],
) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1, ...health }],
        pullRequests: prs,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.reload();
}

test.describe('rate limits follow the server (#806)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('severity exceeded shows the banner even when the numbers look healthy', async ({
    page,
  }) => {
    await open(page, {
      rateLimitREST: {
        limit: 5000,
        remaining: 4000,
        resetsAt: FUTURE(),
        severity: 'exceeded',
      },
    });
    await expect(page.locator('#rate-limit-banner')).toContainText(
      'Rate limit exceeded',
    );
  });

  test('severity low shows the running-low banner', async ({ page }) => {
    await open(page, {
      rateLimitGraphQL: {
        limit: 5000,
        remaining: 4000,
        resetsAt: FUTURE(),
        severity: 'low',
      },
    });
    await expect(page.locator('#rate-limit-banner')).toContainText(
      'Rate limit running low',
    );
  });

  test('severity ok shows no banner even when the numbers look nearly spent', async ({
    page,
  }) => {
    await open(page, {
      rateLimitREST: {
        limit: 5000,
        remaining: 10,
        resetsAt: FUTURE(),
        severity: 'ok',
      },
    });
    await expect(page.locator('#pr-rows')).toBeAttached();
    await expect(page.locator('#rate-limit-banner')).toHaveCount(0);
  });

  test('a coded refusal offers Retry whatever words its message holds', async ({
    page,
  }) => {
    await page.route('**/api/pull-requests/update-branch', (route: Route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'x',
          code: 'conflict',
          // Mentions a rate limit, but the code says it isn't one.
          message: 'Hit a rate limit of conflicting changes',
        }),
      }),
    );
    await open(page, {}, [
      {
        forge: 'github',
        repo: 'alrayyes/forge-dashboard',
        number: 42,
        title: 'Behind',
        url: 'https://example.com/42',
        author: 'claude',
        draft: false,
        ci: 'success',
        labels: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        mergeStatus: 'blocked',
        behind: true,
      },
    ]);

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Update branch' }).click();
    await expect(row).toContainText('Hit a rate limit of conflicting changes');
    await expect(
      row.getByRole('button', { name: /Retry/ }).first(),
    ).toBeVisible();
  });
});
