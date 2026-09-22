const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { registerViaInvite } = require('./register-helper');

async function registerAndSignIn(page, request, baseURL) {
  const username = `pr-renovate-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'PR Renovate Test User',
  );
}

function makePR(overrides) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Update dependency some-package to v2',
    url: 'https://example.com/42',
    author: 'renovate[bot]',
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

// Renovate: Rebase lives behind the row's "More actions" overflow trigger
// (#527) — this opens it, same as a person clicking through.
async function openMoreActions(row) {
  await row.getByRole('button', { name: 'More actions' }).click();
}

test.describe('pull request Renovate rebase button', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    await mockSettings(page);
  });

  test('a Renovate-authored GitHub pull request shows the button', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await expect(
      row.getByRole('button', { name: 'Renovate: Rebase' }),
    ).toBeVisible();
  });

  test('a Renovate-authored Forgejo pull request also shows the button — Renovate runs on both forges', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      'forgejo',
      makePR({ forge: 'forgejo', author: 'renovate[bot]' }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await expect(
      row.getByRole('button', { name: 'Renovate: Rebase' }),
    ).toBeVisible();
  });

  test('the renovate GitHub App author form (bare GraphQL slug) also shows the button', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR({ author: 'renovate' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await expect(
      row.getByRole('button', { name: 'Renovate: Rebase' }),
    ).toBeVisible();
  });

  test('a pull request not authored by Renovate shows no button', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR({ author: 'claude' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'Renovate: Rebase' }),
    ).toHaveCount(0);
  });

  test('clicking calls the API immediately, with no confirm step', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    let requestBody;
    await page.route('**/api/pull-requests/renovate-rebase', (route) => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Renovate: Rebase' }).click();

    expect(requestBody).toEqual({
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 42,
    });
  });

  test('shows an in-progress status while requesting, then a success status', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/renovate-rebase', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Renovate: Rebase' }).click();

    const status = page.locator('#status-banner');
    await expect(status).toContainText(
      'Asking Renovate to rebase alrayyes/forge-dashboard#42…',
    );
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toContainText(
      'Asked Renovate to rebase alrayyes/forge-dashboard#42.',
    );
  });

  test('a transient failure shows an error and re-enables the button for another try', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/renovate-rebase', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: POST .../labels: EOF' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    const button = row.getByRole('button', { name: 'Renovate: Rebase' });
    await button.click();

    await expect(page.locator('#error-banner')).toContainText('EOF');
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  test("a 404 (the configured label doesn't exist) locks the button with its own reason", async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/renovate-rebase', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'forgejo: no label "rebase"' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Renovate: Rebase' }).click();

    const button = row.getByRole('button', { name: 'Renovate: Rebase' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/rebase label doesn't exist/i);
  });

  test('a permission-denied failure locks the button for good instead of inviting another try', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/renovate-rebase', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: POST .../labels: Forbidden' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Renovate: Rebase' }).click();

    const button = row.getByRole('button', { name: 'Renovate: Rebase' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/permission/i);
  });

  test('a rate-limited (429) failure locks the button for good', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/renovate-rebase', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Renovate: Rebase' }).click();

    const button = row.getByRole('button', { name: 'Renovate: Rebase' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/rate limit/i);
  });

  test('a locked button is reachable by keyboard and has no axe-core violations', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/renovate-rebase', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Renovate: Rebase' }).click();
    await expect(
      row.getByRole('button', { name: 'Renovate: Rebase' }),
    ).toHaveAttribute('aria-disabled', 'true');

    await page.keyboard.press('Tab');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
