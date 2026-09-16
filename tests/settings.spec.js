const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');

async function registerAndSignIn(page) {
  await addVirtualAuthenticator(page);
  const username = `settings-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', 'Settings Test User');
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

test.describe('settings page', () => {
  test.beforeEach(async ({ page }) => {
    await registerAndSignIn(page);
  });

  test('dark mode chosen on the dashboard still applies after navigating to settings', async ({
    page,
  }) => {
    // Real bug reported live: settings/admin/login had no theme handling
    // at all, so an explicit dark-mode choice on the dashboard silently
    // reverted to the OS default the moment someone left it.
    await page.click('#theme-toggle');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.goto('/settings.html');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the header settings link reaches the settings page', async ({
    page,
  }) => {
    await page.click('a[href="/settings.html"]');
    await expect(page).toHaveURL(/\/settings\.html$/);
    await expect(page.locator('.settings-header h1')).toHaveText('Settings');
  });

  test('saved settings persist across a reload, and the token never comes back', async ({
    page,
  }) => {
    await page.goto('/settings.html');

    await page.fill(
      '#github-token',
      'ghp_e2e-test-token-should-not-round-trip',
    );
    await page.fill('#github-username', 'octocat');
    await page.fill('#forgejo-url', 'https://git.example.com');
    await page.fill('#forgejo-username', 'octocat-forgejo');
    await page.click('#save-button');

    await expect(page.locator('#status')).toHaveText('Saved.');
    await expect(page.locator('#github-token-badge')).toBeVisible();
    // Cleared after a successful save — the "Configured" badge is what
    // confirms it took, not the input showing the secret back.
    await expect(page.locator('#github-token')).toHaveValue('');

    await page.reload();

    await expect(page.locator('#github-username')).toHaveValue('octocat');
    await expect(page.locator('#forgejo-url')).toHaveValue(
      'https://git.example.com',
    );
    await expect(page.locator('#forgejo-username')).toHaveValue(
      'octocat-forgejo',
    );
    await expect(page.locator('#github-token-badge')).toBeVisible();
    await expect(page.locator('#github-token')).toHaveValue('');
  });

  test('the show/hide toggle reveals and re-masks a token field', async ({
    page,
  }) => {
    await page.goto('/settings.html');

    await page.fill('#github-token', 'ghp_e2e-visibility-check');
    await expect(page.locator('#github-token')).toHaveAttribute(
      'type',
      'password',
    );

    const toggle = page.locator('.token-toggle[data-target="github-token"]');
    await toggle.click();
    await expect(page.locator('#github-token')).toHaveAttribute('type', 'text');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveText('Hide');

    await toggle.click();
    await expect(page.locator('#github-token')).toHaveAttribute(
      'type',
      'password',
    );
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveText('Show');
  });

  test('a Forgejo username with no instance URL is refused before it ever reaches the server', async ({
    page,
  }) => {
    await page.goto('/settings.html');

    await page.fill('#forgejo-username', 'octocat-forgejo');
    await page.click('#save-button');

    await expect(page.locator('#status')).toContainText(/instance url/i);

    await page.reload();
    await expect(page.locator('#forgejo-username')).toHaveValue('', {
      timeout: 5000,
    });
  });

  test('the Forgejo token-settings link tracks the instance URL field and is inert when it is empty', async ({
    page,
  }) => {
    await page.goto('/settings.html');

    await expect(page.locator('#forgejo-token-link')).not.toHaveAttribute(
      'href',
      /.+/,
    );

    await page.fill('#forgejo-url', 'git.example.com');
    await expect(page.locator('#forgejo-token-link')).toHaveAttribute(
      'href',
      'https://git.example.com/user/settings/applications',
    );
  });

  test('webhook URLs and secret are populated, and the secret starts masked', async ({
    page,
  }) => {
    await page.goto('/settings.html');

    // The webhook fields fill in only after the settings fetch resolves —
    // an auto-retrying toHaveValue, not a one-shot inputValue, is what
    // actually waits for that instead of racing it.
    const githubURLLocator = page.locator('#webhook-url-github');
    const forgejoURLLocator = page.locator('#webhook-url-forgejo');
    await expect(githubURLLocator).toHaveValue(/\/api\/webhooks\/github\/.+/);
    await expect(forgejoURLLocator).toHaveValue(/\/api\/webhooks\/forgejo\/.+/);
    const githubURL = await githubURLLocator.inputValue();
    const forgejoURL = await forgejoURLLocator.inputValue();
    // Same token in both URLs, since they identify the same user.
    expect(githubURL.split('/').pop()).toBe(forgejoURL.split('/').pop());

    await expect(page.locator('#webhook-secret')).toHaveAttribute(
      'type',
      'password',
    );
    await expect(page.locator('#webhook-secret')).not.toHaveValue('');
    const secret = await page.locator('#webhook-secret').inputValue();
    expect(secret.length).toBeGreaterThan(0);

    await page.reload();
    await expect(page.locator('#webhook-url-github')).toHaveValue(githubURL);
    await expect(page.locator('#webhook-secret')).toHaveValue(secret);
  });

  test('the webhook secret show/hide toggle works the same as the token fields', async ({
    page,
  }) => {
    await page.goto('/settings.html');

    const toggle = page.locator('.token-toggle[data-target="webhook-secret"]');
    await expect(page.locator('#webhook-secret')).toHaveAttribute(
      'type',
      'password',
    );
    await toggle.click();
    await expect(page.locator('#webhook-secret')).toHaveAttribute(
      'type',
      'text',
    );
    await toggle.click();
    await expect(page.locator('#webhook-secret')).toHaveAttribute(
      'type',
      'password',
    );
  });

  test('copying the GitHub webhook URL confirms it in the status line', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/settings.html');

    // Wait for the settings fetch to fill the field in before copying it —
    // otherwise this can race the same fetch the field's own value does.
    await expect(page.locator('#webhook-url-github')).toHaveValue(
      /\/api\/webhooks\/github\/.+/,
    );
    await page.click('.copy-button[data-copy-target="webhook-url-github"]');
    await expect(page.locator('#webhook-copy-status')).toHaveText('Copied.');

    const clipboardText = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    const expected = await page.locator('#webhook-url-github').inputValue();
    expect(clipboardText).toBe(expected);
  });

  test('copying the webhook secret confirms it in the status line', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/settings.html');

    await expect(page.locator('#webhook-secret')).not.toHaveValue('');
    await page.click('.copy-button[data-copy-target="webhook-secret"]');
    await expect(page.locator('#webhook-copy-status')).toHaveText('Copied.');

    const clipboardText = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    const expected = await page.locator('#webhook-secret').inputValue();
    expect(clipboardText).toBe(expected);
  });

  test('webhook coverage summary is hidden with no tracked repos', async ({
    page,
  }) => {
    await page.goto('/settings.html');

    await expect(page.locator('#webhook-coverage-summary')).toBeHidden();
  });

  test('webhook coverage summary shows the count and links to the webhooks page', async ({
    page,
  }) => {
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [],
          pullRequests: [],
          issues: [],
          repos: [
            { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
            { forge: 'github', fullName: 'alrayyes/b', hasWebhook: false },
            { forge: 'forgejo', fullName: 'alrayyes/c', hasWebhook: false },
          ],
        }),
      }),
    );
    await page.goto('/settings.html');

    const summary = page.locator('#webhook-coverage-summary');
    await expect(summary).toBeVisible();
    await expect(page.locator('#webhook-coverage-count')).toHaveText(
      '1 of 3 confirmed',
    );
    await expect(summary.getByRole('link')).toHaveAttribute(
      'href',
      '/webhooks.html',
    );

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations at desktop width', async ({ page }) => {
    await page.goto('/settings.html');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/settings.html');

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
});
