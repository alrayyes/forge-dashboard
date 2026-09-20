const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { registerViaInvite } = require('./register-helper');

async function registerAndSignIn(page, request, baseURL) {
  const username = `pr-dependabot-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'PR Dependabot Test User',
  );
}

function makePR(overrides) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Bump some-package from 1.0.0 to 1.0.1',
    url: 'https://example.com/42',
    author: 'app/dependabot',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: false,
    ...overrides,
  };
}

function mockDashboard(page, forge, pr) {
  return page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge, reachable: true, repoCount: 1 }],
        pullRequests: pr ? [pr] : [],
        issues: [],
      }),
    }),
  );
}

function mockSettings(page, allowBotPrUpdates) {
  return page.route('**/api/settings/bot-pr-updates', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowBotPrUpdates: allowBotPrUpdates || false }),
    }),
  );
}

test.describe('pull request Dependabot rebase/recreate buttons', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    await mockSettings(page);
  });

  test('a Dependabot-authored GitHub pull request shows both buttons', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'Dependabot: Rebase' }),
    ).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Dependabot: Recreate' }),
    ).toBeVisible();
  });

  test('a pull request not authored by Dependabot shows neither button', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR({ author: 'claude' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: /Dependabot:/ })).toHaveCount(
      0,
    );
  });

  test('a Dependabot-authored pull request on Forgejo shows no button — Dependabot only runs on GitHub', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      'forgejo',
      makePR({ forge: 'forgejo', author: 'app/dependabot' }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: /Dependabot:/ })).toHaveCount(
      0,
    );
  });

  test('clicking Rebase posts the exact rebase action, with no confirm step', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    let requestBody;
    await page.route('**/api/pull-requests/dependabot-action', (route) => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();

    expect(requestBody).toEqual({
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 42,
      action: 'rebase',
    });
  });

  test('clicking Recreate posts the exact recreate action', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    let requestBody;
    await page.route('**/api/pull-requests/dependabot-action', (route) => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Dependabot: Recreate' }).click();

    expect(requestBody).toMatchObject({ action: 'recreate' });
  });

  test('shows an in-progress status while requesting, then a success status', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route(
      '**/api/pull-requests/dependabot-action',
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return route.fulfill({ status: 204 });
      },
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();

    const status = page.locator('#status-banner');
    await expect(status).toContainText(
      'Asking Dependabot to rebase alrayyes/forge-dashboard#42…',
    );
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toContainText(
      'Asked Dependabot to rebase alrayyes/forge-dashboard#42.',
    );
  });

  test('a transient failure shows an error and re-enables the button for another try', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/dependabot-action', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: POST .../comments: EOF' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    const button = row.getByRole('button', { name: 'Dependabot: Rebase' });
    await button.click();

    await expect(page.locator('#error-banner')).toContainText('EOF');
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('a permission-denied failure locks the button for good instead of inviting another try', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/dependabot-action', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: POST .../comments: Forbidden',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();

    const button = row.getByRole('button', { name: 'Dependabot: Rebase' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/permission/i);
  });

  // Mirrors pull-request-update-branch.spec.js's own cross-action
  // forge-wide permission test: forgePermissionDenied is keyed by forge,
  // not by action, since a token's write access isn't specific to one
  // action any more than it's specific to one PR — a 403 from Rebase has
  // to proactively lock Recreate too, for the reason stated there.
  test('a permission failure on Rebase also proactively locks Recreate on the same forge', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/dependabot-action', (route) => {
      const body = route.request().postDataJSON();
      if (body.action === 'rebase') {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Forbidden' }),
        });
      }
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();

    await expect(
      row.getByRole('button', { name: 'Dependabot: Rebase' }),
    ).toHaveAttribute('aria-disabled', 'true');
    const recreateButton = row.getByRole('button', {
      name: 'Dependabot: Recreate',
    });
    await expect(recreateButton).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/permission/i);
  });

  test('a rate-limited (429) failure locks the button for good', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/dependabot-action', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();

    const button = row.getByRole('button', { name: 'Dependabot: Rebase' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/rate limit/i);
  });

  test('a locked button is reachable by keyboard and has no axe-core violations', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/dependabot-action', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();
    await expect(
      row.getByRole('button', { name: 'Dependabot: Rebase' }),
    ).toHaveAttribute('aria-disabled', 'true');

    await page.keyboard.press('Tab');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
