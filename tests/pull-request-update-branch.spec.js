const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');

async function registerAndSignIn(page) {
  await addVirtualAuthenticator(page);
  const username = `pr-update-branch-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', 'PR Update Branch Test User');
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
    mergeStatus: 'blocked',
    behind: true,
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

// mockDashboardCustom, unlike mockDashboard above, takes its own forges
// array and a real list of pull requests — for the proactive-lock tests,
// which need to control ForgeHealth directly and (for the cross-action
// permission-lock test) more than one row.
function mockDashboardCustom(page, forges, prs) {
  return page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges,
        pullRequests: prs,
        issues: [],
      }),
    }),
  );
}

test.describe('pull request update-branch button', () => {
  test.beforeEach(async ({ page }) => {
    await registerAndSignIn(page);
  });

  test('a pull request reported as behind shows an Update branch button', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ behind: true }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'Update branch' }),
    ).toBeVisible();
  });

  test('a pull request not reported as behind shows no Update branch button', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ behind: false }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'Update branch' }),
    ).toHaveCount(0);
  });

  test('a pull request that is both mergeable and behind shows both buttons at once', async ({
    page,
  }) => {
    // The real reason Behind is its own field, not folded into
    // mergeStatus: confirmed live against Forgejo, a pull request can be
    // mergeable and behind at the same time.
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', behind: true }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Update branch' }),
    ).toBeVisible();
  });

  test('clicking calls the API immediately, with no confirm step, and refreshes the board', async ({
    page,
  }) => {
    const pr = makePR();
    await mockDashboard(page, pr);
    let requestBody;
    await page.route('**/api/pull-requests/update-branch', (route) => {
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
          pullRequests: [{ ...pr, behind: false }],
          issues: [],
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Update branch' }).click();

    await expect(
      row.getByRole('button', { name: 'Update branch' }),
    ).toHaveCount(0);
    expect(requestBody).toEqual({
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 42,
    });
  });

  test('shows an in-progress status while updating, then a success status', async ({
    page,
  }) => {
    const pr = makePR();
    await mockDashboard(page, pr);
    await page.route('**/api/pull-requests/update-branch', async (route) => {
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
          pullRequests: [{ ...pr, behind: false }],
          issues: [],
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Update branch' }).click();

    const status = page.locator('#status-banner');
    await expect(status).toContainText(
      'Updating the branch for alrayyes/forge-dashboard#42…',
    );
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toContainText(
      'Updated the branch for alrayyes/forge-dashboard#42.',
    );
  });

  test('a 202 (scheduled as a background job) is treated as success, not a failure', async ({
    page,
  }) => {
    const pr = makePR();
    await mockDashboard(page, pr);
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.fulfill({ status: 202 }),
    );
    await page.route('**/api/dashboard/refresh', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [pr],
          issues: [],
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Update branch' }).click();

    await expect(page.locator('#error-banner')).toHaveCount(0);
  });

  test('a transient failure shows an error and returns to a re-clickable button', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: PUT .../update-branch: EOF' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    const button = row.getByRole('button', { name: 'Update branch' });
    await button.click();

    await expect(page.locator('#error-banner')).toContainText('EOF');
    await expect(page.locator('#status-banner')).toHaveCount(0);
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('a permission-denied failure locks the button for good instead of inviting another try', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PUT .../update-branch: Forbidden',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Update branch' }).click();

    const button = row.getByRole('button', { name: 'Update branch' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/permission/i);
  });

  test('a cannot-merge-cleanly (409) failure locks the button with its own reason', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PUT .../update-branch: Merge conflict',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Update branch' }).click();

    const button = row.getByRole('button', { name: 'Update branch' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/can't update cleanly/i);
  });

  test('a rate-limited (429) failure locks the button for good', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Update branch' }).click();

    const button = row.getByRole('button', { name: 'Update branch' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/rate limit/i);
  });

  test('a locked Update branch button is reachable by keyboard and has no axe-core violations', async ({
    page,
  }) => {
    // mergeStatus stays "mergeable" here rather than makePR's own default
    // "blocked" — the .merge-pill.blocked badge has a real, pre-existing
    // contrast bug (filed as #305) unrelated to this button; this scan is
    // about the locked-button markup this change actually adds.
    await mockDashboard(page, makePR({ mergeStatus: 'mergeable' }));
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Update branch' }).click();

    const button = row.getByRole('button', { name: 'Update branch' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await button.focus();
    await expect(button).toBeFocused();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test.describe('proactive locking, before any click', () => {
    test('a behind PR on an unreachable forge shows a locked Update branch button, no click needed', async ({
      page,
    }) => {
      await mockDashboardCustom(
        page,
        [{ forge: 'github', reachable: false, repoCount: 0 }],
        [makePR()],
      );
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      const button = row.getByRole('button', { name: 'Update branch' });
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(row).toContainText(/unreachable/i);
    });

    test('a behind PR on a forge with an exhausted rate-limit budget shows a locked Update branch button', async ({
      page,
    }) => {
      const resetsAt = new Date(Date.now() + 41 * 60 * 1000).toISOString();
      await mockDashboardCustom(
        page,
        [
          {
            forge: 'github',
            reachable: true,
            repoCount: 1,
            rateLimit: { limit: 5000, remaining: 0, resetsAt },
          },
        ],
        [makePR()],
      );
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      const button = row.getByRole('button', { name: 'Update branch' });
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(row).toContainText(/rate limit exhausted/i);
    });

    // Merge and Update branch share the same forge-wide permission memory
    // — a token's write access isn't specific to one action any more than
    // it's specific to one PR, so a 403 from either action has to lock
    // both, for every PR on that forge, not just the row and the action
    // that happened to be tried first.
    test('a permission failure on Merge for one PR also locks Update branch for a different PR on the same forge', async ({
      page,
    }) => {
      const first = makePR({
        number: 1,
        mergeStatus: 'mergeable',
        behind: false,
      });
      const second = makePR({
        number: 2,
        mergeStatus: 'blocked',
        behind: true,
      });
      await mockDashboardCustom(
        page,
        [{ forge: 'github', reachable: true, repoCount: 2 }],
        [first, second],
      );
      await page.route('**/api/pull-requests/merge', (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'github: PUT .../merge: Forbidden' }),
        }),
      );
      await page.reload();

      const rows = page.locator('#pr-rows .row');
      await rows.nth(0).getByRole('button', { name: 'Merge' }).click();
      await rows.nth(0).getByRole('button', { name: 'Confirm merge?' }).click();
      await expect(
        rows.nth(0).getByRole('button', { name: 'Merge' }),
      ).toHaveAttribute('aria-disabled', 'true');

      const updateBranchButton = rows
        .nth(1)
        .getByRole('button', { name: 'Update branch' });
      await expect(updateBranchButton).toHaveAttribute('aria-disabled', 'true');
      await expect(rows.nth(1)).toContainText(/permission/i);
    });
  });
});
