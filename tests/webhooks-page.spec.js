const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');

async function registerAndSignIn(page) {
  await addVirtualAuthenticator(page);
  const username = `webhooks-page-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', 'Webhooks Page Test User');
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

function mockDashboard(page, repos) {
  return page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos,
      }),
    }),
  );
}

test.describe('webhooks page', () => {
  test.beforeEach(async ({ page }) => {
    await registerAndSignIn(page);
  });

  test('shows an empty state with no tracked repos', async ({ page }) => {
    await mockDashboard(page, []);
    await page.goto('/webhooks.html');

    await expect(page.locator('#webhooks-empty')).toBeVisible();
    await expect(page.locator('#webhooks-table')).toBeHidden();
  });

  test('lists every tracked repo with its live status, sorted by full name', async ({
    page,
  }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/b', hasWebhook: false },
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
    ]);
    await page.goto('/webhooks.html');

    const rows = page.locator('#webhooks-rows tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('alrayyes/a');
    await expect(rows.nth(0)).toContainText('Confirmed');
    await expect(rows.nth(1)).toContainText('alrayyes/b');
    await expect(rows.nth(1)).toContainText('Not yet');
    await expect(
      rows.nth(1).getByRole('button', { name: 'Add a webhook' }),
    ).toBeVisible();
    await expect(
      rows.nth(0).getByRole('button', { name: 'Add a webhook' }),
    ).toHaveCount(0);
  });

  test.describe('filters and sorting', () => {
    function repoFilter(page) {
      return page.locator('#webhooks-repo-filter');
    }

    function forgeRadio(page, value) {
      return page.locator(
        `.webhooks-filter-bar input[data-filter="forge"][value="${value}"]`,
      );
    }

    async function seedRepos(page) {
      await mockDashboard(page, [
        { forge: 'github', fullName: 'alrayyes/b', hasWebhook: true },
        { forge: 'forgejo', fullName: 'alrayyes/a', hasWebhook: false },
        { forge: 'github', fullName: 'alrayyes/c', hasWebhook: false },
      ]);
      await page.goto('/webhooks.html');
    }

    function rowRepoNames(page) {
      return page
        .locator('#webhooks-rows tr td:nth-child(2)')
        .allTextContents();
    }

    test('the forge filter narrows the list to one forge', async ({ page }) => {
      await seedRepos(page);
      await forgeRadio(page, 'forgejo').check();

      await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
      await expect(page.locator('#webhooks-rows tr')).toContainText(
        'alrayyes/a',
      );
    });

    test('the repo text filter narrows the list, case-insensitively', async ({
      page,
    }) => {
      await seedRepos(page);
      await repoFilter(page).fill('B');

      await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
      await expect(page.locator('#webhooks-rows tr')).toContainText(
        'alrayyes/b',
      );
    });

    test('the status filter narrows to confirmed or not-yet repos', async ({
      page,
    }) => {
      await seedRepos(page);
      await page.selectOption('#webhooks-status-filter', 'confirmed');

      await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
      await expect(page.locator('#webhooks-rows tr')).toContainText(
        'alrayyes/b',
      );

      await page.selectOption('#webhooks-status-filter', 'pending');
      await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);
    });

    test('combined filters narrow further than either alone', async ({
      page,
    }) => {
      await seedRepos(page);
      await forgeRadio(page, 'github').check();
      await page.selectOption('#webhooks-status-filter', 'pending');

      await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
      await expect(page.locator('#webhooks-rows tr')).toContainText(
        'alrayyes/c',
      );
    });

    test('no results shows a message instead of an empty table', async ({
      page,
    }) => {
      await seedRepos(page);
      await repoFilter(page).fill('nothing-matches-this');

      await expect(page.locator('#webhooks-table')).toBeHidden();
      await expect(page.locator('#webhooks-no-results')).toBeVisible();
    });

    test('clicking the Repo header reverses sort direction, updating aria-sort', async ({
      page,
    }) => {
      await seedRepos(page);
      // Default: ascending by full name already.
      await expect(rowRepoNames(page)).resolves.toEqual([
        'alrayyes/a',
        'alrayyes/b',
        'alrayyes/c',
      ]);
      const repoHeader = page.locator('th', {
        has: page.locator('[data-sort-key="fullName"]'),
      });
      await expect(repoHeader).toHaveAttribute('aria-sort', 'ascending');

      await page.click('[data-sort-key="fullName"]');

      await expect(rowRepoNames(page)).resolves.toEqual([
        'alrayyes/c',
        'alrayyes/b',
        'alrayyes/a',
      ]);
      await expect(repoHeader).toHaveAttribute('aria-sort', 'descending');
    });

    test('clicking the Webhook header sorts by status, and resets the Repo header to unsorted', async ({
      page,
    }) => {
      await seedRepos(page);
      await page.click('[data-sort-key="hasWebhook"]');

      // Not yet (false) sorts before Confirmed (true) ascending.
      await expect(rowRepoNames(page)).resolves.toEqual([
        'alrayyes/a',
        'alrayyes/c',
        'alrayyes/b',
      ]);
      const webhookHeader = page.locator('th', {
        has: page.locator('[data-sort-key="hasWebhook"]'),
      });
      await expect(webhookHeader).toHaveAttribute('aria-sort', 'ascending');
      const repoHeader = page.locator('th', {
        has: page.locator('[data-sort-key="fullName"]'),
      });
      await expect(repoHeader).toHaveAttribute('aria-sort', 'none');
    });

    test('a filter change resets to page 1', async ({ page }) => {
      const repos = Array.from({ length: 30 }, (_, i) => ({
        forge: i < 26 ? 'github' : 'forgejo',
        fullName: `alrayyes/repo-${String(i).padStart(2, '0')}`,
        hasWebhook: false,
      }));
      await mockDashboard(page, repos);
      await page.goto('/webhooks.html');
      await page.locator('.pagination-page', { hasText: '2' }).click();
      await expect(page.locator('#webhooks-rows tr')).toHaveCount(5);

      await forgeRadio(page, 'forgejo').check();

      await expect(page.locator('#webhooks-rows tr')).toHaveCount(4);
      await expect(page.locator('#webhooks-pagination')).toBeHidden();
    });

    test('has no axe-core violations with the filter bar and a sorted table rendered', async ({
      page,
    }) => {
      await seedRepos(page);
      await page.click('[data-sort-key="hasWebhook"]');

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });

  test('clicking "Add a webhook" calls the API and flips the row to confirmed on success', async ({
    page,
  }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: false },
    ]);
    let requestBody;
    await page.route('**/api/webhooks/ensure', (route) => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await page.goto('/webhooks.html');

    const row = page.locator('#webhooks-rows tr').first();
    await row.getByRole('button', { name: 'Add a webhook' }).click();

    await expect(row).toContainText('Confirmed');
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(page.locator('#webhooks-status')).toContainText(
      'Webhook added for alrayyes/a.',
    );
    expect(requestBody).toEqual({ forge: 'github', fullName: 'alrayyes/a' });
  });

  test('a failed create shows a specific error and re-enables the button', async ({
    page,
  }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: false },
    ]);
    await page.route('**/api/webhooks/ensure', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: 403 insufficient scope' }),
      }),
    );
    await page.goto('/webhooks.html');

    const button = page
      .locator('#webhooks-rows tr')
      .first()
      .getByRole('button', { name: 'Add a webhook' });
    await button.click();

    await expect(page.locator('#webhooks-status')).toContainText(
      'insufficient scope',
    );
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('Add a webhook');
  });

  test('paginates at 25 per page, same convention as the pull request/issue boards', async ({
    page,
  }) => {
    const repos = Array.from({ length: 30 }, (_, i) => ({
      forge: 'github',
      fullName: `alrayyes/repo-${String(i).padStart(2, '0')}`,
      hasWebhook: false,
    }));
    await mockDashboard(page, repos);
    await page.goto('/webhooks.html');

    await expect(page.locator('#webhooks-rows tr')).toHaveCount(25);
    await expect(page.locator('#webhooks-pagination')).toBeVisible();

    await page.locator('.pagination-page', { hasText: '2' }).click();
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(5);
  });

  test('a set under one page shows no pagination controls', async ({
    page,
  }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
    ]);
    await page.goto('/webhooks.html');

    await expect(page.locator('#webhooks-pagination')).toBeHidden();
  });

  test('has no axe-core violations at desktop width', async ({ page }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      { forge: 'github', fullName: 'alrayyes/b', hasWebhook: false },
    ]);
    await page.goto('/webhooks.html');
    await expect(page.locator('#webhooks-table')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      { forge: 'github', fullName: 'alrayyes/b', hasWebhook: false },
    ]);
    await page.goto('/webhooks.html');
    await expect(page.locator('#webhooks-table')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    const clientWidth = await page.evaluate(
      () => document.documentElement.clientWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test('the persistent nav highlights Webhooks and still links to Settings', async ({
    page,
  }) => {
    await mockDashboard(page, []);
    await page.goto('/webhooks.html');

    await expect(page.locator('a[aria-label="Webhooks"]')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('a[aria-label="Settings"]')).toHaveAttribute(
      'href',
      '/settings.html',
    );
  });
});
