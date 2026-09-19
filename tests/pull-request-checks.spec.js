const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');

async function registerAndSignIn(page) {
  await addVirtualAuthenticator(page);
  const username = `pr-checks-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', 'PR Checks Test User');
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

function makePR(overrides) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Add structured logging',
    url: 'https://example.com/42',
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
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

function mockChecks(page, body, status = 200) {
  return page.route('**/api/pull-requests/checks*', (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
}

test.describe('pull request pipeline checks panel', () => {
  test.beforeEach(async ({ page }) => {
    await registerAndSignIn(page);
  });

  test('a pull request with CI reported shows the View pipeline button', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'View pipeline' }),
    ).toBeVisible();
  });

  test('a pull request with no CI at all shows no button', async ({ page }) => {
    await mockDashboard(page, 'github', makePR({ ci: 'none' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'View pipeline' }),
    ).toHaveCount(0);
  });

  test('clicking View pipeline requests checks for that exact pull request and lists them', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    let requestURL;
    await mockChecks(page, {
      checks: [
        {
          name: 'build',
          state: 'success',
          url: 'https://github.com/alrayyes/forge-dashboard/runs/1',
        },
        {
          name: 'test',
          state: 'running',
          url: 'https://github.com/alrayyes/forge-dashboard/runs/2',
        },
      ],
    });
    page.on('request', (req) => {
      if (req.url().includes('/api/pull-requests/checks'))
        requestURL = req.url();
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'View pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('alrayyes/forge-dashboard#42');

    const items = dialog.locator('.pipeline-check');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('build');
    await expect(items.nth(0)).toContainText('Passed');
    await expect(items.nth(1)).toContainText('test');
    await expect(items.nth(1)).toContainText('Running');

    const buildLink = dialog.getByRole('link', { name: 'View run: build' });
    await expect(buildLink).toHaveAttribute(
      'href',
      'https://github.com/alrayyes/forge-dashboard/runs/1',
    );
    await expect(buildLink).toHaveAttribute('target', '_blank');
    await expect(buildLink).toHaveAttribute('rel', 'noopener');

    const url = new URL(requestURL);
    expect(url.searchParams.get('forge')).toBe('github');
    expect(url.searchParams.get('fullName')).toBe('alrayyes/forge-dashboard');
    expect(url.searchParams.get('number')).toBe('42');
  });

  test('no checks at all shows a plain "no CI configured" message', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, { checks: [] });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'View pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toContainText(
      'No CI configured for this pull request.',
    );
  });

  test('a failed fetch shows an error and a Retry that re-fetches', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    let attempts = 0;
    await page.route('**/api/pull-requests/checks*', (route) => {
      attempts += 1;
      if (attempts === 1) {
        return route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'github: unreachable' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checks: [
            { name: 'build', state: 'success', url: 'https://example.com/1' },
          ],
        }),
      });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'View pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toContainText(/unreachable/i);
    await expect(page.locator('#error-banner')).toContainText(/unreachable/i);

    await dialog.getByRole('button', { name: 'Retry' }).click();
    await expect(dialog.locator('.pipeline-check')).toHaveCount(1);
  });

  test('Escape closes the panel and returns focus to the row button', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, { checks: [] });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    const trigger = row.getByRole('button', { name: 'View pipeline' });
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('the close button closes the panel', async ({ page }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, { checks: [] });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'View pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await dialog.getByRole('button', { name: 'Close pipeline checks' }).click();
    await expect(dialog).toBeHidden();
  });

  test('the open panel is reachable by keyboard and has no axe-core violations', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        { name: 'build', state: 'success', url: 'https://example.com/1' },
        { name: 'test', state: 'failure', url: 'https://example.com/2' },
      ],
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'View pipeline' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Pipeline checks' }),
    ).toBeVisible();

    await page.keyboard.press('Tab');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
