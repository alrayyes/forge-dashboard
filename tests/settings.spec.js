const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { registerViaInvite } = require('./register-helper');

async function registerAndSignIn(page, request, baseURL) {
  const username = `settings-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'Settings Test User',
  );
}

test.describe('settings page', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test.describe('theme control (#352)', () => {
    test('defaults to System, with no theme applied', async ({ page }) => {
      await page.goto('/settings.html');
      await expect(page.locator('#settings-form')).toBeVisible();

      await expect(
        page.locator('.theme-segmented input[value=""]'),
      ).toBeChecked();
      await expect(page.locator('html')).not.toHaveAttribute('data-theme');
    });

    test('choosing Dark applies immediately, with no Save step', async ({
      page,
    }) => {
      await page.goto('/settings.html');

      await page.click('.theme-segmented label:has-text("Dark")');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(
        page.locator('.theme-segmented input[value="dark"]'),
      ).toBeChecked();
    });

    // #529: the real race wasn't a slow assertion — it's that
    // selectTheme's own PUT (web/src/routes/(app)/settings/+page.svelte)
    // fires and forgets, so a reload issued before it lands can beat it
    // to the server. The root layout's syncThemeFromServer then runs on
    // the fresh page's mount, GETs the still-unsaved (stale) theme, finds
    // it disagrees with the cookie theme.js just applied, and "reconciles"
    // by overwriting the cookie and clearing data-theme back out — a
    // permanent wrong value, not a slow-to-arrive correct one, so no
    // amount of extra timeout on the later assertion would have fixed it
    // reliably. Waiting for the PUT's own response before reloading is
    // what actually closes the race.
    test('a choice survives a reload and following to another page', async ({
      page,
    }) => {
      await page.goto('/settings.html');
      await Promise.all([
        page.waitForResponse(
          (res) =>
            res.url().includes('/api/settings/theme') &&
            res.request().method() === 'PUT',
        ),
        page.click('.theme-segmented label:has-text("Dark")'),
      ]);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(
        page.locator('.theme-segmented input[value="dark"]'),
      ).toBeChecked();

      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    });

    // #548: unlike the race above, this one isn't closed by awaiting the
    // PUT before reloading — a real user's reload doesn't know to wait.
    // The save is held here so its own then/catch/finally never run in
    // this tab at all before the reload, and the reload's own GET
    // (syncThemeFromServer, web/src/lib/theme.ts) is left seeing the
    // still-unsaved server value, the exact "hadn't landed yet" state
    // the ticket describes — deterministic, not a race against real
    // network timing.
    test('a choice survives a reload that outraces its own save', async ({
      page,
    }) => {
      await page.goto('/settings.html');

      let releasePut;
      const putHeld = new Promise((resolve) => {
        releasePut = resolve;
      });
      let firstPutIntercepted = false;
      await page.route('**/api/settings/theme', async (route) => {
        if (route.request().method() === 'PUT' && !firstPutIntercepted) {
          firstPutIntercepted = true;
          await putHeld;
          try {
            await route.abort();
          } catch {
            /* the tab that made this request already navigated away */
          }
          return;
        }
        await route.continue();
      });

      await page.click('.theme-segmented label:has-text("Dark")');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(
        page.locator('.theme-segmented input[value="dark"]'),
      ).toBeChecked();

      releasePut();

      // Not just displayed correctly on this load — the save needs to
      // actually land server-side too, or the very next real reload
      // would revert it right back.
      await expect(async () => {
        const res = await page.request.get('/api/settings/theme');
        expect((await res.json()).theme).toBe('dark');
      }).toPass();
    });

    test('switching back to Light removes the dark attribute', async ({
      page,
    }) => {
      await page.goto('/settings.html');
      await page.click('.theme-segmented label:has-text("Dark")');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

      await page.click('.theme-segmented label:has-text("Light")');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    });
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

  test('allowing bot-managed PR updates persists across a reload, along with the Renovate rebase label', async ({
    page,
  }) => {
    await page.goto('/settings.html');

    await expect(page.locator('#renovate-rebase-label-field')).toBeHidden();

    await page.check('#allow-bot-pr-updates');
    await expect(page.locator('#renovate-rebase-label-field')).toBeVisible();
    await page.fill('#renovate-rebase-label', 'retry');
    await page.click('#save-button');

    await expect(page.locator('#status')).toHaveText('Saved.');

    await page.reload();

    await expect(page.locator('#allow-bot-pr-updates')).toBeChecked();
    await expect(page.locator('#renovate-rebase-label-field')).toBeVisible();
    await expect(page.locator('#renovate-rebase-label')).toHaveValue('retry');
  });

  test('the Renovate rebase label field stays hidden until bot-managed PR updates are allowed', async ({
    page,
  }) => {
    await page.goto('/settings.html');

    await expect(page.locator('#renovate-rebase-label-field')).toBeHidden();

    await page.check('#allow-bot-pr-updates');
    await expect(page.locator('#renovate-rebase-label-field')).toBeVisible();

    await page.uncheck('#allow-bot-pr-updates');
    await expect(page.locator('#renovate-rebase-label-field')).toBeHidden();
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

  test('the GitHub fine-grained permissions are a real list, not one run-on line', async ({
    page,
  }) => {
    // Regression test for a real readability complaint: this hint used
    // to be a single <p>, every sentence and every permission run
    // together with no visual break at all.
    await page.goto('/settings.html');

    const items = page.locator('#github-token-hint ul li');
    await expect(items).toHaveCount(6);
    await expect(items.nth(0)).toContainText('Metadata');
    await expect(items.nth(5)).toContainText('Webhooks');
  });

  test('the Forgejo permission list includes read:user, easy to leave out and silently break repo discovery', async ({
    page,
  }) => {
    // Regression test: the hint's old prose form named write:repository
    // and read:issue but never read:user, even though GET /user/repos —
    // the README's own Credentials section documents this with a real
    // 403 it hit live — refuses a token missing it.
    await page.goto('/settings.html');

    await expect(page.locator('#forgejo-token-hint')).toContainText(
      'read:user',
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

  test.describe('Passkeys (#355)', () => {
    test('the initial passkey from registration is already listed, with its Remove button disabled', async ({
      page,
    }) => {
      await page.goto('/settings.html');

      const items = page.locator('#passkey-list li');
      await expect(items).toHaveCount(1);
      await expect(items.first()).toContainText('Initial passkey');
      await expect(items.first()).toContainText('Created');
      await expect(
        items.first().getByRole('button', { name: 'Remove' }),
      ).toBeDisabled();
      await expect(page.locator('#passkey-empty')).toBeHidden();
    });

    test('adding a second passkey lists both, and the Remove button becomes enabled', async ({
      page,
    }) => {
      await page.goto('/settings.html');

      await page.fill('#passkey-label', 'YubiKey');
      await page.click('#passkey-form button[type="submit"]');

      await expect(page.locator('#passkey-status')).toHaveText(
        'Added "YubiKey".',
      );
      const items = page.locator('#passkey-list li');
      await expect(items).toHaveCount(2);
      await expect(items.nth(1)).toContainText('YubiKey');
      await expect(
        items.first().getByRole('button', { name: 'Remove' }),
      ).toBeEnabled();
      await expect(
        items.nth(1).getByRole('button', { name: 'Remove' }),
      ).toBeEnabled();
    });

    test('removing a passkey when more than one exists removes just that one', async ({
      page,
    }) => {
      await page.goto('/settings.html');
      await page.fill('#passkey-label', 'YubiKey');
      await page.click('#passkey-form button[type="submit"]');
      await expect(page.locator('#passkey-list li')).toHaveCount(2);

      await page
        .locator('#passkey-list li')
        .nth(1)
        .getByRole('button', { name: 'Remove' })
        .click();

      await expect(page.locator('#passkey-status')).toHaveText('Removed.');
      const items = page.locator('#passkey-list li');
      await expect(items).toHaveCount(1);
      await expect(items.first()).toContainText('Initial passkey');
      await expect(
        items.first().getByRole('button', { name: 'Remove' }),
      ).toBeDisabled();
    });

    // The button being disabled is a client-side convenience — this
    // proves the real guard lives server-side too, not just in the UI,
    // by calling the endpoint directly, bypassing the disabled button
    // entirely.
    test('the server itself refuses to remove the last remaining passkey', async ({
      page,
    }) => {
      await page.goto('/settings.html');
      const passkeyId = await page
        .locator('#passkey-list li button.btn-remove')
        .first()
        .getAttribute('data-passkey-id');

      const resp = await page.request.delete(
        `/api/auth/credentials/${passkeyId}`,
      );

      expect(resp.status()).toBe(400);
      await expect(page.locator('#passkey-list li')).toHaveCount(1);
    });

    test('has no axe-core violations with two passkeys listed', async ({
      page,
    }) => {
      await page.goto('/settings.html');
      await page.fill('#passkey-label', 'YubiKey');
      await page.click('#passkey-form button[type="submit"]');
      await expect(page.locator('#passkey-list li')).toHaveCount(2);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });

  test.describe('API tokens', () => {
    test('no tokens yet shows the empty state, not a blank list', async ({
      page,
    }) => {
      await page.goto('/settings.html');

      await expect(page.locator('#api-token-empty')).toBeVisible();
      await expect(page.locator('#api-token-list li')).toHaveCount(0);
    });

    test('generating a token reveals it once, and lists it without the raw value', async ({
      page,
    }) => {
      await page.goto('/settings.html');

      await page.fill('#token-label', 'ci script');
      await page.click('#token-form button[type="submit"]');

      await expect(page.locator('#token-status')).toHaveText(
        'Generated "ci script".',
      );
      const reveal = page.locator('#token-reveal-value');
      await expect(page.locator('#token-reveal-field')).toBeVisible();
      const rawToken = await reveal.inputValue();
      expect(rawToken).toMatch(/^fdb_/);

      const item = page.locator('#api-token-list li').first();
      await expect(item).toContainText('ci script');
      await expect(item).not.toContainText(rawToken);
      await expect(page.locator('#api-token-empty')).toBeHidden();
    });

    test.describe('expiration (#356)', () => {
      test('30 days is pre-selected, and there is no "never expires" option', async ({
        page,
      }) => {
        await page.goto('/settings.html');

        await expect(page.locator('#token-expiry-preset')).toHaveValue('30');
        const optionValues = await page
          .locator('#token-expiry-preset option')
          .evaluateAll((opts) => opts.map((o) => o.value));
        expect(optionValues).toEqual(['7', '30', '60', '90', 'custom']);
      });

      test('generating with the default 30-day preset shows an expiration date on the listed token', async ({
        page,
      }) => {
        await page.goto('/settings.html');

        await page.fill('#token-label', 'ci script');
        await page.click('#token-form button[type="submit"]');

        const item = page.locator('#api-token-list li').first();
        await expect(item).toContainText('Expires');
      });

      test('picking a preset other than 30 still creates and lists the token', async ({
        page,
      }) => {
        await page.goto('/settings.html');

        await page.selectOption('#token-expiry-preset', '90');
        await page.fill('#token-label', 'ci script');
        await page.click('#token-form button[type="submit"]');

        await expect(page.locator('#token-reveal-field')).toBeVisible();
        await expect(page.locator('#api-token-list li')).toHaveCount(1);
      });

      test('choosing "Custom date…" reveals a date field capped at 366 days out, and requires a value before submitting', async ({
        page,
      }) => {
        await page.goto('/settings.html');
        await expect(page.locator('#token-expiry-custom-date')).toHaveCount(0);

        await page.selectOption('#token-expiry-preset', 'custom');

        const dateField = page.locator('#token-expiry-custom-date');
        await expect(dateField).toBeVisible();
        await expect(dateField).toHaveAttribute('required', '');
        const max = await dateField.getAttribute('max');
        const min = await dateField.getAttribute('min');
        const daysOut = Math.round(
          (new Date(max) - new Date(min)) / (24 * 60 * 60 * 1000),
        );
        expect(daysOut).toBe(365); // min is tomorrow, max is 366 days from today

        await page.fill('#token-label', 'ci script');
        await page.click('#token-form button[type="submit"]');

        // The native date input's own required attribute blocks the
        // form submit entirely — nothing reaches submitGenerateToken,
        // so no request goes out and no status message appears.
        await expect(page.locator('#token-reveal-field')).toBeHidden();
      });

      test('a custom date within range creates and lists the token', async ({
        page,
      }) => {
        await page.goto('/settings.html');

        await page.selectOption('#token-expiry-preset', 'custom');
        const inTwoWeeks = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        await page.fill('#token-expiry-custom-date', inTwoWeeks);
        await page.fill('#token-label', 'ci script');
        await page.click('#token-form button[type="submit"]');

        await expect(page.locator('#token-reveal-field')).toBeVisible();
        const item = page.locator('#api-token-list li').first();
        await expect(item).toContainText('Expires');
      });

      test('has no axe-core violations with the custom date field revealed', async ({
        page,
      }) => {
        await page.goto('/settings.html');
        await page.selectOption('#token-expiry-preset', 'custom');
        await expect(page.locator('#token-expiry-custom-date')).toBeVisible();

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    });

    test('reloading no longer shows the raw token, only its metadata', async ({
      page,
    }) => {
      await page.goto('/settings.html');
      await page.fill('#token-label', 'ci script');
      await page.click('#token-form button[type="submit"]');
      await expect(page.locator('#token-reveal-field')).toBeVisible();

      await page.reload();

      await expect(page.locator('#token-reveal-field')).toBeHidden();
      await expect(page.locator('#api-token-list li').first()).toContainText(
        'ci script',
      );
    });

    test('a generated token actually authenticates a real API request as a Bearer credential', async ({
      page,
      request,
    }) => {
      await page.goto('/settings.html');
      await page.fill('#token-label', 'ci script');
      await page.click('#token-form button[type="submit"]');
      await expect(page.locator('#token-reveal-field')).toBeVisible();
      const rawToken = await page.locator('#token-reveal-value').inputValue();

      const resp = await request.get('/api/tokens', {
        headers: { Authorization: `Bearer ${rawToken}` },
      });

      expect(resp.status()).toBe(200);
    });

    test('revoking a token removes it from the list and stops it authenticating', async ({
      page,
      request,
    }) => {
      await page.goto('/settings.html');
      await page.fill('#token-label', 'ci script');
      await page.click('#token-form button[type="submit"]');
      await expect(page.locator('#token-reveal-field')).toBeVisible();
      const rawToken = await page.locator('#token-reveal-value').inputValue();
      await expect(page.locator('#api-token-list li')).toHaveCount(1);

      // Confirms the token actually worked before revoking it — otherwise
      // the 401 assertion below would trivially pass even for a broken
      // or empty token, proving nothing about revocation specifically.
      const beforeRevoke = await request.get('/api/tokens', {
        headers: { Authorization: `Bearer ${rawToken}` },
      });
      expect(beforeRevoke.status()).toBe(200);

      await page.click('#api-token-list button.btn-remove');

      await expect(page.locator('#token-status')).toHaveText('Revoked.');
      await expect(page.locator('#api-token-list li')).toHaveCount(0);
      await expect(page.locator('#api-token-empty')).toBeVisible();

      const resp = await request.get('/api/tokens', {
        headers: { Authorization: `Bearer ${rawToken}` },
      });
      expect(resp.status()).toBe(401);
    });

    test('copying the revealed token confirms it in the token status line', async ({
      page,
      context,
    }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.goto('/settings.html');
      await page.fill('#token-label', 'ci script');
      await page.click('#token-form button[type="submit"]');
      await expect(page.locator('#token-reveal-field')).toBeVisible();

      await page.click(
        '.token-copy-button[data-copy-target="token-reveal-value"]',
      );

      await expect(page.locator('#token-status')).toHaveText('Copied.');
      const clipboardText = await page.evaluate(() =>
        navigator.clipboard.readText(),
      );
      const expected = await page.locator('#token-reveal-value').inputValue();
      expect(clipboardText).toBe(expected);
    });

    test('has no axe-core violations with a token generated and listed', async ({
      page,
    }) => {
      await page.goto('/settings.html');
      await page.fill('#token-label', 'ci script');
      await page.click('#token-form button[type="submit"]');
      await expect(page.locator('#token-reveal-field')).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });

  test('has no axe-core violations with the Renovate rebase label field revealed', async ({
    page,
  }) => {
    await page.goto('/settings.html');
    await page.check('#allow-bot-pr-updates');
    await expect(page.locator('#renovate-rebase-label-field')).toBeVisible();

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
