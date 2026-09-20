const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { registerViaInvite } = require('./register-helper');

async function registerAndSignIn(page, request, baseURL) {
  const username = `pr-close-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'PR Close Test User',
  );
}

function makePR(overrides) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    ...overrides,
  };
}

function mockDashboard(page, pr) {
  return page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: pr ? [pr] : [],
        issues: [],
      }),
    }),
  );
}

test.describe('pull request close button', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  // mergeStatus: 'blocked' throughout — Close shows regardless of
  // mergeability, unlike Merge, which is exactly the point (a PR that
  // can't be merged is often exactly the one that needs closing).
  test('a pull request shows a Close button even when it cannot be merged', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Close' })).toBeVisible();
  });

  test('clicking Close arms a confirm step instead of closing immediately', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    let closeCalled = false;
    await page.route('**/api/pull-requests/close', (route) => {
      closeCalled = true;
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Close' }).click();

    await expect(
      row.getByRole('button', { name: 'Confirm close?' }),
    ).toBeVisible();
    await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(closeCalled).toBe(false);
  });

  test('clicking Close moves keyboard focus to the new Confirm close button', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Close' }).click();

    await expect(
      row.getByRole('button', { name: 'Confirm close?' }),
    ).toBeFocused();
  });

  test('Cancel returns to the plain Close button without calling the API', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    let closeCalled = false;
    await page.route('**/api/pull-requests/close', (route) => {
      closeCalled = true;
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Close' }).click();
    await row.getByRole('button', { name: 'Cancel' }).click();

    await expect(row.getByRole('button', { name: 'Close' })).toBeVisible();
    expect(closeCalled).toBe(false);
  });

  test('confirming calls the close API with forge/fullName/number and refreshes the board', async ({
    page,
  }) => {
    const pr = makePR();
    await mockDashboard(page, pr);
    let requestBody;
    await page.route('**/api/pull-requests/close', (route) => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/dashboard/refresh', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues: [],
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Close' }).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    await expect(page.locator('#pr-rows .row')).toHaveCount(0);
    expect(requestBody).toEqual({
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 42,
    });
  });

  test('shows an in-progress status while closing, then a success status', async ({
    page,
  }) => {
    const pr = makePR();
    await mockDashboard(page, pr);
    await page.route('**/api/pull-requests/close', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/dashboard/refresh', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues: [],
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Close' }).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    const status = page.locator('#status-banner');
    await expect(status).toContainText('Closing alrayyes/forge-dashboard#42…');
    await expect(status).toContainText('Closed alrayyes/forge-dashboard#42.');
  });

  // Regression coverage for #501's own fix: the forge's real rejection
  // reason (not a bare status code) must reach this error banner.
  test("a rejected close shows the forge's own reason, and returns to a re-clickable Close button", async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PATCH .../pulls/42: pull request already merged',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Close' }).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    await expect(page.locator('#error-banner')).toContainText(
      'pull request already merged',
    );
    const button = row.getByRole('button', { name: 'Close' });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });

  test('a permission-denied failure locks the button with a real Retry, not a dead end', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PATCH .../pulls/42: Forbidden',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Close' }).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    const button = row.getByRole('button', { name: 'Retry' });
    await expect(button).toBeVisible();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/permission/i);
  });

  test('a rate-limited (429) failure locks the button with a real Retry', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Close' }).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    const button = row.getByRole('button', { name: 'Retry' });
    await expect(button).toBeVisible();
    await expect(row).toContainText(/rate limit/i);
  });

  test('a locked Close button is reachable by keyboard and has no axe-core violations', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Close' }).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    const button = row.getByRole('button', { name: 'Retry' });
    await expect(button).toBeVisible();
    await button.focus();
    await expect(button).toBeFocused();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
