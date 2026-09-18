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

// mockDashboardCustom, unlike mockDashboard above, takes its own forges
// array and a real list of pull requests — for the proactive-lock tests,
// which need to control ForgeHealth directly and (for the forge-wide
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

  // Regression test for a real bug report: a click on "Merge" read as
  // doing nothing at all, because the confirm-step swap had nothing
  // drawing the eye to it.
  test('clicking Merge moves keyboard focus to the new Confirm merge button', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();

    await expect(
      row.getByRole('button', { name: 'Confirm merge?' }),
    ).toBeFocused();
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

  test('shows an in-progress status while merging, then a success status', async ({
    page,
  }) => {
    const pr = makePR();
    await mockDashboard(page, pr);
    await page.route('**/api/pull-requests/merge', async (route) => {
      // Held open briefly so the in-progress status has a moment to be
      // observed before the success one replaces it.
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
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const status = page.locator('#status-banner');
    await expect(status).toContainText('Merging alrayyes/forge-dashboard#42…');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toContainText('Merged alrayyes/forge-dashboard#42.');
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
    await expect(page.locator('#error-banner')).toHaveAttribute(
      'role',
      'alert',
    );
    // No lingering "Merging…" status once the error banner is showing —
    // otherwise both would compete for attention at once.
    await expect(page.locator('#status-banner')).toHaveCount(0);
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

  test('a 409 caused by a disallowed merge method shows the real forge message, not a generic "no longer mergeable" guess', async ({
    page,
  }) => {
    // Real bug: GitHub's merge endpoint uses the same 409 for two
    // different causes (a PR that's genuinely not mergeable, and a merge
    // method the repo doesn't allow — #349) — the old hardcoded "no
    // longer mergeable" text was simply wrong for this one.
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error:
            'github: PUT .../merge: Merge commits are not allowed on this repository.',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const button = row.getByRole('button', { name: 'Merge' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(
      'Merge commits are not allowed on this repository.',
    );
    await expect(row).not.toContainText(/no longer mergeable/i);
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

  test('has no axe-core violations with the status banner rendered', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', async (route) => {
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
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();
    await expect(page.locator('#status-banner')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test.describe('proactive locking, before any click', () => {
    test('a mergeable PR on an unreachable forge shows a locked Merge button, no click needed', async ({
      page,
    }) => {
      await mockDashboardCustom(
        page,
        [{ forge: 'github', reachable: false, repoCount: 0 }],
        [makePR()],
      );
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      const button = row.getByRole('button', { name: 'Merge' });
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(row).toContainText(/unreachable/i);
    });

    test('a mergeable PR on a forge with an exhausted rate-limit budget shows a locked Merge button', async ({
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
      const button = row.getByRole('button', { name: 'Merge' });
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(row).toContainText(/rate limit exhausted/i);
    });

    test('a permission failure on one PR also locks Merge for a different, not-yet-tried PR on the same forge', async ({
      page,
    }) => {
      const first = makePR({ number: 1 });
      const second = makePR({ number: 2 });
      await mockDashboardCustom(
        page,
        [{ forge: 'github', reachable: true, repoCount: 2 }],
        [first, second],
      );
      await page.route('**/api/pull-requests/merge', (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'github: PUT .../merge: Forbidden',
          }),
        }),
      );
      await page.reload();

      const rows = page.locator('#pr-rows .row');
      await rows.nth(0).getByRole('button', { name: 'Merge' }).click();
      await rows.nth(0).getByRole('button', { name: 'Confirm merge?' }).click();
      await expect(
        rows.nth(0).getByRole('button', { name: 'Merge' }),
      ).toHaveAttribute('aria-disabled', 'true');

      // The second PR's own Merge button was never clicked, and never
      // itself made a request — it's locked purely from the first PR's
      // failure, because a token's write permission is an account-wide
      // property, not a per-PR one.
      const secondButton = rows.nth(1).getByRole('button', { name: 'Merge' });
      await expect(secondButton).toHaveAttribute('aria-disabled', 'true');
      await expect(rows.nth(1)).toContainText(/permission/i);
    });
  });
});
