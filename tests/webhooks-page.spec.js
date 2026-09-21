const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { registerViaInvite } = require('./register-helper');

async function registerAndSignIn(page, request, baseURL) {
  const username = `webhooks-page-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'Webhooks Page Test User',
  );
}

function mockDashboard(page, repos, forges) {
  return page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: forges || [],
        pullRequests: [],
        issues: [],
        repos,
      }),
    }),
  );
}

test.describe('webhooks page', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
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
      {
        forge: 'github',
        fullName: 'alrayyes/b',
        hasWebhook: false,
        canManageWebhooks: true,
      },
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
      {
        forge: 'github',
        fullName: 'alrayyes/a',
        hasWebhook: false,
        canManageWebhooks: true,
      },
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
    await expect(
      row.getByRole('button', { name: 'Add a webhook' }),
    ).toHaveCount(0);
    await expect(page.locator('#webhooks-status')).toContainText(
      'Webhook added for alrayyes/a.',
    );
    expect(requestBody).toEqual({ forge: 'github', fullName: 'alrayyes/a' });
  });

  test('a transient failure shows a specific error and re-enables the button for another try', async ({
    page,
  }) => {
    await mockDashboard(page, [
      {
        forge: 'github',
        fullName: 'alrayyes/a',
        hasWebhook: false,
        canManageWebhooks: true,
      },
    ]);
    await page.route('**/api/webhooks/ensure', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: GET /repos/alrayyes/a/hooks: EOF',
        }),
      }),
    );
    await page.goto('/webhooks.html');

    const button = page
      .locator('#webhooks-rows tr')
      .first()
      .getByRole('button', { name: 'Add a webhook' });
    await button.click();

    await expect(page.locator('#webhooks-status')).toContainText('EOF');
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveText('Add a webhook');
  });

  test('a forge whose rate limit is already exhausted shows a disabled button with the reset time, not a clickable one', async ({
    page,
  }) => {
    const resetsAt = new Date(Date.now() + 41 * 60 * 1000).toISOString();
    await mockDashboard(
      page,
      [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: false,
          canManageWebhooks: true,
        },
      ],
      [
        {
          forge: 'github',
          reachable: true,
          repoCount: 1,
          rateLimitREST: { limit: 5000, remaining: 0, resetsAt },
        },
      ],
    );
    await page.goto('/webhooks.html');

    const row = page.locator('#webhooks-rows tr').first();
    const button = row.getByRole('button', { name: 'Add a webhook' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText('resets');

    // The row's own click handler never fires for a disabled control — no
    // request should go out even if something did click it.
    let requested = false;
    await page.route('**/api/webhooks/ensure', (route) => {
      requested = true;
      return route.fulfill({ status: 204 });
    });
    await button.click({ force: true });
    expect(requested).toBe(false);
  });

  test('a permission-denied failure disables the button for good instead of inviting another try', async ({
    page,
  }) => {
    await mockDashboard(page, [
      {
        forge: 'github',
        fullName: 'alrayyes/a',
        hasWebhook: false,
        canManageWebhooks: true,
      },
    ]);
    await page.route('**/api/webhooks/ensure', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error:
            'github: GET /repos/alrayyes/a/hooks: Resource not accessible by personal access token',
        }),
      }),
    );
    await page.goto('/webhooks.html');

    const row = page.locator('#webhooks-rows tr').first();
    const button = row.getByRole('button', { name: 'Add a webhook' });
    await button.click();

    // The locked-button reason (asserted below via `row`) already says
    // why in plain language — the status line doesn't also need the raw
    // API string as its primary text. The +page.svelte's setStatus only
    // attaches a details disclosure for failures the lock doesn't cover.
    await expect(page.locator('#webhooks-status')).toContainText(
      "Couldn't add a webhook for alrayyes/a.",
    );
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/token|permission/i);
  });

  test('a rate-limited failure disables the button for good, same as a known-exhausted budget', async ({
    page,
  }) => {
    await mockDashboard(page, [
      {
        forge: 'github',
        fullName: 'alrayyes/a',
        hasWebhook: false,
        canManageWebhooks: true,
      },
    ]);
    await page.route('**/api/webhooks/ensure', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.goto('/webhooks.html');

    const row = page.locator('#webhooks-rows tr').first();
    const button = row.getByRole('button', { name: 'Add a webhook' });
    await button.click();

    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/rate limit/i);
  });

  test('a locked button is reachable by keyboard and has no axe-core violations', async ({
    page,
  }) => {
    const resetsAt = new Date(Date.now() + 41 * 60 * 1000).toISOString();
    await mockDashboard(
      page,
      [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: false,
          canManageWebhooks: true,
        },
      ],
      [
        {
          forge: 'github',
          reachable: true,
          repoCount: 1,
          rateLimitREST: { limit: 5000, remaining: 0, resetsAt },
        },
      ],
    );
    await page.goto('/webhooks.html');

    const button = page
      .locator('#webhooks-rows tr')
      .first()
      .getByRole('button', { name: 'Add a webhook' });
    await button.focus();
    await expect(button).toBeFocused();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
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
      {
        forge: 'github',
        fullName: 'alrayyes/b',
        hasWebhook: false,
        canManageWebhooks: true,
      },
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
      {
        forge: 'github',
        fullName: 'alrayyes/b',
        hasWebhook: false,
        canManageWebhooks: true,
      },
      // The one row shape most likely to overflow: a long repo name
      // paired with the "Needs admin access…" explanatory sentence,
      // the widest thing this table ever renders.
      {
        forge: 'github',
        fullName: 'HilmarDouma/Meldpunt-incidenten.nl',
        hasWebhook: false,
        canManageWebhooks: false,
      },
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

  test('a repo the user lacks admin access to explains itself instead of showing a broken button', async ({
    page,
  }) => {
    await mockDashboard(page, [
      {
        forge: 'github',
        fullName: 'SSVAPEX/apex-website',
        hasWebhook: false,
        canManageWebhooks: false,
      },
    ]);
    await page.goto('/webhooks.html');

    const row = page.locator('#webhooks-rows tr').first();
    await expect(
      row.getByRole('button', { name: 'Add a webhook' }),
    ).toHaveCount(0);
    await expect(row).toContainText(/admin access/i);
    await expect(
      row.getByRole('link', { name: 'set it up manually' }),
    ).toHaveAttribute('href', '/settings.html#webhooks');
  });

  test('a permission-denied repo has no axe-core violations', async ({
    page,
  }) => {
    await mockDashboard(page, [
      {
        forge: 'github',
        fullName: 'SSVAPEX/apex-website',
        hasWebhook: false,
        canManageWebhooks: false,
      },
    ]);
    await page.goto('/webhooks.html');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('the repo name links out to the repo on its forge', async ({ page }) => {
    await mockDashboard(page, [
      {
        forge: 'github',
        fullName: 'alrayyes/forge-dashboard',
        url: 'https://github.com/alrayyes/forge-dashboard',
        hasWebhook: true,
      },
    ]);
    await page.goto('/webhooks.html');

    const link = page.getByRole('link', {
      name: 'alrayyes/forge-dashboard',
    });
    await expect(link).toHaveAttribute(
      'href',
      'https://github.com/alrayyes/forge-dashboard',
    );
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test.describe('bulk "set up webhooks for all repos" action (#380)', () => {
    function bulkButton(page) {
      return page.getByRole('button', { name: /Set up webhooks for/ });
    }

    test('shows the count of repos actually missing a webhook', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: false,
          canManageWebhooks: true,
        },
        {
          forge: 'github',
          fullName: 'alrayyes/b',
          hasWebhook: false,
          canManageWebhooks: true,
        },
        {
          forge: 'github',
          fullName: 'alrayyes/c',
          hasWebhook: true,
          canManageWebhooks: true,
        },
      ]);
      await page.goto('/webhooks.html');

      await expect(bulkButton(page)).toContainText('2');
    });

    test('is not shown once every repo already has a webhook', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          canManageWebhooks: true,
        },
      ]);
      await page.goto('/webhooks.html');

      await expect(bulkButton(page)).toHaveCount(0);
    });

    test('does not count a repo the user lacks admin access to — nothing a bulk click could actually fix', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: false,
          canManageWebhooks: false,
        },
      ]);
      await page.goto('/webhooks.html');

      await expect(bulkButton(page)).toHaveCount(0);
    });

    test('prompts for confirmation with the real count, and does nothing if dismissed', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: false,
          canManageWebhooks: true,
        },
      ]);
      let ensureCalled = false;
      await page.route('**/api/webhooks/ensure', (route) => {
        ensureCalled = true;
        return route.fulfill({ status: 204 });
      });
      await page.goto('/webhooks.html');

      let dialogMessage = '';
      page.once('dialog', (dialog) => {
        dialogMessage = dialog.message();
        void dialog.dismiss();
      });
      await bulkButton(page).click();

      expect(dialogMessage).toContain('1');
      expect(ensureCalled).toBe(false);
    });

    test('confirming sets up a webhook on every eligible repo and reports a final count', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: false,
          canManageWebhooks: true,
        },
        {
          forge: 'github',
          fullName: 'alrayyes/b',
          hasWebhook: false,
          canManageWebhooks: true,
        },
      ]);
      const requested = [];
      await page.route('**/api/webhooks/ensure', (route) => {
        requested.push(route.request().postDataJSON());
        return route.fulfill({ status: 204 });
      });
      await page.goto('/webhooks.html');

      page.once('dialog', (dialog) => void dialog.accept());
      await bulkButton(page).click();

      await expect(page.locator('#webhooks-status')).toContainText('2');
      await expect(page.locator('.status-confirmed')).toHaveCount(2);
      expect(requested).toEqual(
        expect.arrayContaining([
          { forge: 'github', fullName: 'alrayyes/a' },
          { forge: 'github', fullName: 'alrayyes/b' },
        ]),
      );
      expect(requested).toHaveLength(2);
    });

    test('a repo that fails during the batch is reported on its own row, without stopping the rest', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: false,
          canManageWebhooks: true,
        },
        {
          forge: 'github',
          fullName: 'alrayyes/b',
          hasWebhook: false,
          canManageWebhooks: true,
        },
      ]);
      await page.route('**/api/webhooks/ensure', (route) => {
        const body = route.request().postDataJSON();
        if (body.fullName === 'alrayyes/a') {
          return route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'missing permission' }),
          });
        }
        return route.fulfill({ status: 204 });
      });
      await page.goto('/webhooks.html');

      page.once('dialog', (dialog) => void dialog.accept());
      await bulkButton(page).click();

      const rowA = page.locator('#webhooks-rows tr', { hasText: 'alrayyes/a' });
      const rowB = page.locator('#webhooks-rows tr', { hasText: 'alrayyes/b' });
      await expect(rowB).toContainText('Confirmed');
      await expect(rowA).not.toContainText('Confirmed');
      await expect(rowA).toContainText(/permission/i);
    });

    test('has no axe-core violations with the bulk button visible', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: false,
          canManageWebhooks: true,
        },
      ]);
      await page.goto('/webhooks.html');
      await expect(bulkButton(page)).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });

  test.describe('ignoring a repo (#363, #511)', () => {
    test('choosing "Ignore both" calls the API and moves the repo into the Ignored disclosure', async ({
      page,
    }) => {
      await mockDashboard(page, [
        { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      ]);
      let requestBody;
      await page.route('**/api/repos/ignore', (route) => {
        requestBody = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      });
      await page.goto('/webhooks.html');

      await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
      await page
        .locator('#webhooks-rows tr')
        .first()
        .getByRole('combobox', { name: 'Ignore alrayyes/a' })
        .selectOption('both');

      await expect(page.locator('#webhooks-rows tr')).toHaveCount(0);
      await expect(page.locator('#webhooks-no-results')).toBeVisible();
      const disclosure = page.locator('#webhooks-ignored');
      await expect(disclosure.locator('summary')).toContainText('Ignored (1)');
      await expect(disclosure).toContainText('alrayyes/a');
      await expect(disclosure).toContainText('(PRs, issues)');
      await expect(page.locator('#webhooks-status')).toContainText(
        'alrayyes/a is now ignored',
      );
      expect(requestBody).toEqual({
        forge: 'github',
        fullName: 'alrayyes/a',
        prs: true,
        issues: true,
      });
    });

    test('choosing "Ignore PRs" sends prs:true, issues:false and shows the scope in the disclosure', async ({
      page,
    }) => {
      await mockDashboard(page, [
        { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      ]);
      let requestBody;
      await page.route('**/api/repos/ignore', (route) => {
        requestBody = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      });
      await page.goto('/webhooks.html');

      await page
        .locator('#webhooks-rows tr')
        .first()
        .getByRole('combobox', { name: 'Ignore alrayyes/a' })
        .selectOption('prs');

      // The route handler's requestBody assignment races the fetch it's
      // waiting on — this disclosure text only appears once the whole
      // round trip (request, 204, repo.ignored* mutation, re-render) has
      // settled, so waiting on it first is what makes the plain
      // (non-retrying) requestBody assertion below safe to make.
      const disclosure = page.locator('#webhooks-ignored');
      await expect(disclosure).toContainText('(PRs)');
      expect(requestBody).toEqual({
        forge: 'github',
        fullName: 'alrayyes/a',
        prs: true,
        issues: false,
      });
    });

    test('choosing "Ignore issues" sends prs:false, issues:true and shows the scope in the disclosure', async ({
      page,
    }) => {
      await mockDashboard(page, [
        { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      ]);
      let requestBody;
      await page.route('**/api/repos/ignore', (route) => {
        requestBody = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      });
      await page.goto('/webhooks.html');

      await page
        .locator('#webhooks-rows tr')
        .first()
        .getByRole('combobox', { name: 'Ignore alrayyes/a' })
        .selectOption('issues');

      // See the "Ignore PRs" test above for why the disclosure text is
      // awaited before this plain (non-retrying) requestBody assertion.
      const disclosure = page.locator('#webhooks-ignored');
      await expect(disclosure).toContainText('(issues)');
      expect(requestBody).toEqual({
        forge: 'github',
        fullName: 'alrayyes/a',
        prs: false,
        issues: true,
      });
    });

    test('no repos ignored shows no disclosure at all', async ({ page }) => {
      await mockDashboard(page, [
        { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      ]);
      await page.goto('/webhooks.html');

      await expect(page.locator('#webhooks-ignored')).toHaveCount(0);
    });

    test('an already-ignored repo starts inside the disclosure, not the main table', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          ignored: true,
          ignoredPRs: true,
          ignoredIssues: true,
        },
        { forge: 'github', fullName: 'alrayyes/b', hasWebhook: false },
      ]);
      await page.goto('/webhooks.html');

      await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
      await expect(page.locator('#webhooks-rows tr')).toContainText(
        'alrayyes/b',
      );
      const disclosure = page.locator('#webhooks-ignored');
      await expect(disclosure.locator('summary')).toContainText('Ignored (1)');
      await expect(disclosure).toContainText('alrayyes/a');
    });

    test('clicking "Un-ignore" calls the API and moves the repo back into the main table', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          ignored: true,
          ignoredPRs: true,
          ignoredIssues: true,
        },
      ]);
      let requestBody;
      await page.route('**/api/repos/unignore', (route) => {
        requestBody = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      });
      await page.goto('/webhooks.html');

      await page.locator('#webhooks-ignored summary').click();
      await page
        .locator('#webhooks-ignored')
        .getByRole('button', { name: 'Un-ignore' })
        .click();

      await expect(page.locator('#webhooks-ignored')).toHaveCount(0);
      await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
      await expect(page.locator('#webhooks-rows tr')).toContainText(
        'alrayyes/a',
      );
      await expect(page.locator('#webhooks-status')).toContainText(
        'alrayyes/a is no longer ignored.',
      );
      expect(requestBody).toEqual({ forge: 'github', fullName: 'alrayyes/a' });
    });

    test('a failed ignore shows an error and leaves the repo in the main table', async ({
      page,
    }) => {
      await mockDashboard(page, [
        { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      ]);
      await page.route('**/api/repos/ignore', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'could not save' }),
        }),
      );
      await page.goto('/webhooks.html');

      await page
        .locator('#webhooks-rows tr')
        .first()
        .getByRole('combobox', { name: 'Ignore alrayyes/a' })
        .selectOption('both');

      await expect(page.locator('#webhooks-status')).toContainText(
        "Couldn't ignore alrayyes/a",
      );
      await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
      await expect(page.locator('#webhooks-ignored')).toHaveCount(0);
    });

    test('has no axe-core violations with the Ignored disclosure expanded', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          ignored: true,
          ignoredPRs: true,
          ignoredIssues: true,
        },
        { forge: 'github', fullName: 'alrayyes/b', hasWebhook: false },
      ]);
      await page.goto('/webhooks.html');
      await page.locator('#webhooks-ignored summary').click();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });

  test.describe('per-repo auto-update-branch toggle (#365)', () => {
    test('a repo with it off shows "Enable auto-update"; clicking calls the enable endpoint', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          autoUpdateBranch: false,
        },
      ]);
      let requestBody;
      await page.route('**/api/repos/auto-update-branch/enable', (route) => {
        requestBody = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      });
      await page.goto('/webhooks.html');

      const row = page.locator('#webhooks-rows tr').first();
      await expect(
        row.getByRole('button', { name: 'Enable auto-update' }),
      ).toBeVisible();
      await row.getByRole('button', { name: 'Enable auto-update' }).click();

      await expect(
        row.getByRole('button', { name: 'Disable auto-update' }),
      ).toBeVisible();
      await expect(page.locator('#webhooks-status')).toContainText(
        'Auto-update-branch enabled for alrayyes/a',
      );
      expect(requestBody).toEqual({ forge: 'github', fullName: 'alrayyes/a' });
    });

    test('a repo with it on shows "Disable auto-update"; clicking calls the disable endpoint', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          autoUpdateBranch: true,
        },
      ]);
      let requestBody;
      await page.route('**/api/repos/auto-update-branch/disable', (route) => {
        requestBody = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      });
      await page.goto('/webhooks.html');

      const row = page.locator('#webhooks-rows tr').first();
      await row.getByRole('button', { name: 'Disable auto-update' }).click();

      await expect(
        row.getByRole('button', { name: 'Enable auto-update' }),
      ).toBeVisible();
      await expect(page.locator('#webhooks-status')).toContainText(
        'Auto-update-branch disabled for alrayyes/a',
      );
      expect(requestBody).toEqual({ forge: 'github', fullName: 'alrayyes/a' });
    });

    test('a failed toggle shows an error and leaves the row state unchanged', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          autoUpdateBranch: false,
        },
      ]);
      await page.route('**/api/repos/auto-update-branch/enable', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'could not save' }),
        }),
      );
      await page.goto('/webhooks.html');

      const row = page.locator('#webhooks-rows tr').first();
      await row.getByRole('button', { name: 'Enable auto-update' }).click();

      await expect(page.locator('#webhooks-status')).toContainText(
        "Couldn't enable auto-update-branch for alrayyes/a",
      );
      await expect(
        row.getByRole('button', { name: 'Enable auto-update' }),
      ).toBeVisible();
    });
  });

  test.describe('bulk auto-update-branch on/off for all repos (#365)', () => {
    test('shows an "Enable auto-update" bulk button counting repos with it off', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          autoUpdateBranch: false,
        },
        {
          forge: 'github',
          fullName: 'alrayyes/b',
          hasWebhook: true,
          autoUpdateBranch: true,
        },
      ]);
      await page.goto('/webhooks.html');

      await expect(
        page.getByRole('button', { name: /Enable auto-update for/ }),
      ).toContainText('1');
      await expect(
        page.getByRole('button', { name: /Disable auto-update for/ }),
      ).toContainText('1');
    });

    test('is not shown once every repo already matches', async ({ page }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          autoUpdateBranch: true,
        },
      ]);
      await page.goto('/webhooks.html');

      await expect(
        page.getByRole('button', { name: /Enable auto-update for/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: /Disable auto-update for/ }),
      ).toBeVisible();
    });

    test('prompts for confirmation with the real count, and does nothing if dismissed', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          autoUpdateBranch: false,
        },
      ]);
      let called = false;
      await page.route('**/api/repos/auto-update-branch/enable', (route) => {
        called = true;
        return route.fulfill({ status: 204 });
      });
      await page.goto('/webhooks.html');

      let dialogMessage = '';
      page.once('dialog', (dialog) => {
        dialogMessage = dialog.message();
        void dialog.dismiss();
      });
      await page
        .getByRole('button', { name: /Enable auto-update for/ })
        .click();

      expect(dialogMessage).toContain('1');
      expect(called).toBe(false);
    });

    test('confirming enables auto-update-branch on every repo missing it and reports a final count', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          autoUpdateBranch: false,
        },
        {
          forge: 'github',
          fullName: 'alrayyes/b',
          hasWebhook: true,
          autoUpdateBranch: false,
        },
      ]);
      const requested = [];
      await page.route('**/api/repos/auto-update-branch/enable', (route) => {
        requested.push(route.request().postDataJSON());
        return route.fulfill({ status: 204 });
      });
      await page.goto('/webhooks.html');

      page.once('dialog', (dialog) => void dialog.accept());
      await page
        .getByRole('button', { name: /Enable auto-update for/ })
        .click();

      await expect(page.locator('#webhooks-status')).toContainText(
        'Enabled auto-update-branch for all 2 repos.',
      );
      expect(requested).toEqual(
        expect.arrayContaining([
          { forge: 'github', fullName: 'alrayyes/a' },
          { forge: 'github', fullName: 'alrayyes/b' },
        ]),
      );
      expect(requested).toHaveLength(2);
    });

    test('confirming disables auto-update-branch on every repo that has it', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          autoUpdateBranch: true,
        },
      ]);
      const requested = [];
      await page.route('**/api/repos/auto-update-branch/disable', (route) => {
        requested.push(route.request().postDataJSON());
        return route.fulfill({ status: 204 });
      });
      await page.goto('/webhooks.html');

      page.once('dialog', (dialog) => void dialog.accept());
      await page
        .getByRole('button', { name: /Disable auto-update for/ })
        .click();

      await expect(page.locator('#webhooks-status')).toContainText(
        'Disabled auto-update-branch for all 1 repos.',
      );
      expect(requested).toEqual([{ forge: 'github', fullName: 'alrayyes/a' }]);
    });

    test('has no axe-core violations with both bulk buttons visible', async ({
      page,
    }) => {
      await mockDashboard(page, [
        {
          forge: 'github',
          fullName: 'alrayyes/a',
          hasWebhook: true,
          autoUpdateBranch: false,
        },
        {
          forge: 'github',
          fullName: 'alrayyes/b',
          hasWebhook: true,
          autoUpdateBranch: true,
        },
      ]);
      await page.goto('/webhooks.html');
      await expect(
        page.getByRole('button', { name: /Enable auto-update for/ }),
      ).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
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
