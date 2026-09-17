const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');

async function registerAndSignIn(page) {
  await addVirtualAuthenticator(page);
  const username = `pr-merge-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', 'PR Merge Test User');
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
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
    mergeStatus: 'mergeable',
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

test.describe('pull request merge button', () => {
  test.beforeEach(async ({ page }) => {
    await registerAndSignIn(page);
  });

  test('a mergeable pull request shows a Merge button', async ({ page }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'mergeable' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
  });

  test('a conflicting pull request shows no Merge button', async ({ page }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'conflicting' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toHaveCount(0);
  });

  test('a blocked pull request shows no Merge button', async ({ page }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'blocked' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toHaveCount(0);
  });

  test('clicking Merge arms a confirm step instead of merging immediately', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    let mergeCalled = false;
    await page.route('**/api/pull-requests/merge', (route) => {
      mergeCalled = true;
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();

    await expect(
      row.getByRole('button', { name: 'Confirm merge?' }),
    ).toBeVisible();
    await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(mergeCalled).toBe(false);
  });

  test('Cancel returns to the plain Merge button without calling the API', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    let mergeCalled = false;
    await page.route('**/api/pull-requests/merge', (route) => {
      mergeCalled = true;
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Cancel' }).click();

    await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
    expect(mergeCalled).toBe(false);
  });

  test('confirming calls the merge API with forge/fullName/number and refreshes the board', async ({
    page,
  }) => {
    const pr = makePR();
    await mockDashboard(page, pr);
    let requestBody;
    await page.route('**/api/pull-requests/merge', (route) => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    // Once merged, the immediate refresh this triggers reports the PR
    // gone — the same way a real merge would drop it from the next
    // snapshot.
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
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    await expect(page.locator('#pr-rows .row')).toHaveCount(0);
    expect(requestBody).toEqual({
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 42,
    });
  });

  test('a transient failure shows an error and returns to a re-clickable Merge button', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: PUT .../merge: EOF' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    await expect(page.locator('#error-banner')).toContainText('EOF');
    const button = row.getByRole('button', { name: 'Merge' });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('a permission-denied failure locks the button for good instead of inviting another try', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: PUT .../merge: Forbidden' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const button = row.getByRole('button', { name: 'Merge' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/permission/i);
  });

  test('a not-mergeable (409) failure locks the button with a refresh-and-recheck reason', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PUT .../merge: Pull Request is not mergeable',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const button = row.getByRole('button', { name: 'Merge' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/no longer mergeable/i);
  });

  test('a rate-limited (429) failure locks the button for good', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const button = row.getByRole('button', { name: 'Merge' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/rate limit/i);
  });

  test('a locked Merge button is reachable by keyboard and has no axe-core violations', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const button = row.getByRole('button', { name: 'Merge' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await button.focus();
    await expect(button).toBeFocused();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
