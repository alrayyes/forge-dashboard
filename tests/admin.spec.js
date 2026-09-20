// `apiRequest` here is Playwright's top-level APIRequest factory (its own
// `.newContext()` builds an isolated context carrying a chosen
// storageState) — not the per-test `request` fixture a test callback
// destructures, which has no `.newContext()` of its own (its plain
// `.post()`/`.get()` etc. still work fine, and stay as `request` below).
// See register-helper.js's own top-of-file comment for the real bug this
// distinction caused live.
const { test, expect, request: apiRequest } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { registerViaInvite } = require('./register-helper');
const {
  ADMIN_TEST_USERNAME: ADMIN_USERNAME,
  STORAGE_STATE_PATH: ADMIN_STORAGE_STATE,
} = require('./admin-global-setup');

function uniqueUsername(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// Creates an invite as the admin (an HTTP-only round trip, no page
// involved) — the admin area's own "generate an invite" journey is
// covered separately, in its own test below; this is just setup for
// tests whose actual concern is something else (a non-admin's own view
// of the page, the user-management table).
async function createInviteAsAdmin(baseURL, username, displayName) {
  const adminRequest = await apiRequest.newContext({
    baseURL,
    storageState: ADMIN_STORAGE_STATE,
  });
  const res = await adminRequest.post('/api/admin/invites', {
    data: { username, displayName },
  });
  const invite = await res.json();
  await adminRequest.dispose();
  return invite.token;
}

test.describe('admin area', () => {
  test('a non-admin who navigates here directly is bounced to the dashboard', async ({
    page,
    request,
    baseURL,
  }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      uniqueUsername('admin-test-nonadmin'),
      'Not An Admin',
    );

    await page.goto('/admin.html');

    await expect(page).toHaveURL(/\/$/);
  });

  test('lists every user, and lets an admin revoke or remove one', async ({
    browser,
    request,
    baseURL,
  }) => {
    const targetUsername = uniqueUsername('admin-test-target');

    const targetContext = await browser.newContext();
    try {
      const targetPage = await targetContext.newPage();
      await registerViaInvite(
        targetPage,
        request,
        baseURL,
        targetUsername,
        'Target User',
      );

      const adminContext = await browser.newContext({
        storageState: ADMIN_STORAGE_STATE,
      });
      try {
        const adminPage = await adminContext.newPage();
        await adminPage.goto('/admin.html');

        await expect(adminPage.locator('#user-rows')).toContainText(
          targetUsername,
        );

        // The admin's own row has no working action buttons — there's no
        // recovery path for locking yourself out, so the backend refuses
        // it and the frontend doesn't offer it. Matched on the row's own
        // data-username attribute, not hasText — a substring match
        // against "admin" would also catch this file's own
        // "admin-test-*" usernames.
        const adminRow = adminPage.locator(
          `tr[data-username="${ADMIN_USERNAME}"]`,
        );
        await expect(
          adminRow.locator('button[data-action="revoke"]'),
        ).toBeDisabled();
        await expect(
          adminRow.locator('button[data-action="remove"]'),
        ).toBeDisabled();

        adminPage.once('dialog', (dialog) => dialog.accept());
        await adminPage.click(
          'button[data-action="revoke"][data-username="' +
            targetUsername +
            '"]',
        );
        await expect(adminPage.locator('#status')).toContainText('revoked');

        // The revoked user's existing session should no longer work — a
        // reload bounces them to login, same as any expired session.
        await targetPage.reload();
        await expect(targetPage).toHaveURL(/\/login\.html$/);

        adminPage.once('dialog', (dialog) => dialog.accept());
        await adminPage.click(
          'button[data-action="remove"][data-username="' +
            targetUsername +
            '"]',
        );
        await expect(adminPage.locator('#status')).toContainText('removed');
        await expect(adminPage.locator('#user-rows')).not.toContainText(
          targetUsername,
        );
      } finally {
        await adminContext.close();
      }
    } finally {
      await targetContext.close();
    }
  });

  // Each axe-core test closes its context in a finally block — a browser
  // context left open after a failed assertion here has, in practice,
  // gone on to break an unrelated later test in this same worker (real
  // failure seen live: a leaked context here surfaced as a WebAuthn
  // ceremony timeout in a completely different test).
  test('has no axe-core violations at desktop width', async ({ browser }) => {
    const adminContext = await browser.newContext({
      storageState: ADMIN_STORAGE_STATE,
    });
    try {
      const adminPage = await adminContext.newPage();
      await adminPage.goto('/admin.html');
      await expect(adminPage.locator('#user-rows tr').first()).toBeVisible();

      const results = await new AxeBuilder({ page: adminPage })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    } finally {
      await adminContext.close();
    }
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext({
      storageState: ADMIN_STORAGE_STATE,
      viewport: { width: 390, height: 844 },
    });
    try {
      const adminPage = await adminContext.newPage();
      await adminPage.goto('/admin.html');
      await expect(adminPage.locator('#user-rows tr').first()).toBeVisible();

      const results = await new AxeBuilder({ page: adminPage })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);

      const scrollWidth = await adminPage.evaluate(
        () => document.documentElement.scrollWidth,
      );
      const clientWidth = await adminPage.evaluate(
        () => document.documentElement.clientWidth,
      );
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      // The table itself used to need its own horizontal scroll within
      // .card even though the page-level check above stayed green — real
      // device testing found people didn't notice the hidden scroll
      // affordance and just saw a cut-off table. The user table now
      // restyles into stacked cards at this width instead.
      const card = adminPage.locator('.card').first();
      const cardScrollWidth = await card.evaluate((el) => el.scrollWidth);
      const cardClientWidth = await card.evaluate((el) => el.clientWidth);
      expect(cardScrollWidth).toBeLessThanOrEqual(cardClientWidth);
    } finally {
      await adminContext.close();
    }
  });

  test('generates an invite, lists it as outstanding with no axe-core violations, and revoking it removes it from the list', async ({
    browser,
  }) => {
    const username = uniqueUsername('admin-test-invitee');
    const adminContext = await browser.newContext({
      storageState: ADMIN_STORAGE_STATE,
    });
    try {
      const adminPage = await adminContext.newPage();
      await adminPage.goto('/admin.html');

      await adminPage.fill('#invite-username', username);
      await adminPage.fill('#invite-display-name', 'Invitee Test User');
      await adminPage.click('#invite-submit');

      await expect(adminPage.locator('#invite-status')).toContainText(
        'generated',
      );
      await expect(adminPage.locator('#generated-link-value')).toHaveValue(
        new RegExp(`/login\\.html\\?invite=.+&username=${username}`),
      );
      await expect(adminPage.locator('#invite-rows')).toContainText(username);

      // Scan with the generated-link box and the newly listed outstanding
      // invite both actually on the page — not an empty Invites card,
      // which would pass trivially without exercising any of this new
      // markup (rules/a11y.md).
      const results = await new AxeBuilder({ page: adminPage })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);

      adminPage.once('dialog', (dialog) => dialog.accept());
      await adminPage.click(
        `button[data-action="revoke-invite"][data-username="${username}"]`,
      );
      await expect(adminPage.locator('#invite-status')).toContainText(
        'revoked',
      );
      await expect(adminPage.locator('#invite-rows')).not.toContainText(
        username,
      );
    } finally {
      await adminContext.close();
    }
  });

  test('a revoked invite can no longer complete a registration', async ({
    browser,
    request,
    baseURL,
  }) => {
    const username = uniqueUsername('admin-test-revoked-invite');
    const token = await createInviteAsAdmin(
      baseURL,
      username,
      'Revoked Invite User',
    );

    const adminContext = await browser.newContext({
      storageState: ADMIN_STORAGE_STATE,
    });
    try {
      const adminPage = await adminContext.newPage();
      await adminPage.goto('/admin.html');
      await expect(adminPage.locator('#invite-rows')).toContainText(username);

      adminPage.once('dialog', (dialog) => dialog.accept());
      await adminPage.click(
        `button[data-action="revoke-invite"][data-username="${username}"]`,
      );
      await expect(adminPage.locator('#invite-status')).toContainText(
        'revoked',
      );
    } finally {
      await adminContext.close();
    }

    const registerRes = await request.post('/api/auth/register/begin', {
      data: { username, displayName: '', inviteToken: token },
    });
    expect(registerRes.status()).toBe(403);
  });
});
