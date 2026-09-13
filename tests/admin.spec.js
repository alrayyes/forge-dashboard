const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');

// Matches ADMIN_USERNAME in .github/workflows/ci.yml's e2e job — the one
// username the server itself designates as admin, so it can only ever be
// registered once against the shared server this whole file runs against.
// Every test below reuses that one registration's session via storageState
// rather than registering (or logging back in as) "admin" a second time.
const ADMIN_USERNAME = 'admin';

function uniqueUsername(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

async function registerUser(page, username, displayName) {
  await addVirtualAuthenticator(page);
  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', displayName);
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

test.describe('admin area', () => {
  // beforeAll registers ADMIN_USERNAME exactly once against the shared
  // e2e server — not idempotent, since a second registration attempt
  // finds the username already taken. A retried test re-runs beforeAll
  // in a fresh worker, which would try to register "admin" again and
  // fail; disabling retries here means a real beforeAll failure surfaces
  // as a failure instead of a second, doomed registration attempt.
  test.describe.configure({ retries: 0 });

  let adminStorageState;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await registerUser(page, ADMIN_USERNAME, 'Admin');
    adminStorageState = await context.storageState();
    await context.close();
  });

  test('a non-admin who navigates here directly is bounced to the dashboard', async ({ page }) => {
    await registerUser(page, uniqueUsername('admin-test-nonadmin'), 'Not An Admin');

    await page.goto('/admin.html');

    await expect(page).toHaveURL(/\/$/);
  });

  test('lists every user, and lets an admin revoke or remove one', async ({ browser }) => {
    const targetUsername = uniqueUsername('admin-test-target');

    const targetContext = await browser.newContext();
    try {
      const targetPage = await targetContext.newPage();
      await registerUser(targetPage, targetUsername, 'Target User');

      const adminContext = await browser.newContext({ storageState: adminStorageState });
      try {
        const adminPage = await adminContext.newPage();
        await adminPage.goto('/admin.html');

        await expect(adminPage.locator('#user-rows')).toContainText(targetUsername);

        // The admin's own row has no working action buttons — there's no
        // recovery path for locking yourself out, so the backend refuses
        // it and the frontend doesn't offer it. Matched on the row's own
        // data-username attribute, not hasText — a substring match
        // against "admin" would also catch this file's own
        // "admin-test-*" usernames.
        const adminRow = adminPage.locator('tr[data-username="' + ADMIN_USERNAME + '"]');
        await expect(adminRow.locator('button[data-action="revoke"]')).toBeDisabled();
        await expect(adminRow.locator('button[data-action="remove"]')).toBeDisabled();

        adminPage.once('dialog', (dialog) => dialog.accept());
        await adminPage.click('button[data-action="revoke"][data-username="' + targetUsername + '"]');
        await expect(adminPage.locator('#status')).toContainText('revoked');

        // The revoked user's existing session should no longer work — a
        // reload bounces them to login, same as any expired session.
        await targetPage.reload();
        await expect(targetPage).toHaveURL(/\/login\.html$/);

        adminPage.once('dialog', (dialog) => dialog.accept());
        await adminPage.click('button[data-action="remove"][data-username="' + targetUsername + '"]');
        await expect(adminPage.locator('#status')).toContainText('removed');
        await expect(adminPage.locator('#user-rows')).not.toContainText(targetUsername);
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
    const adminContext = await browser.newContext({ storageState: adminStorageState });
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

  test('has no axe-core violations and no horizontal scroll at phone width', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: adminStorageState, viewport: { width: 390, height: 844 } });
    try {
      const adminPage = await adminContext.newPage();
      await adminPage.goto('/admin.html');
      await expect(adminPage.locator('#user-rows tr').first()).toBeVisible();

      const results = await new AxeBuilder({ page: adminPage })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);

      const scrollWidth = await adminPage.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await adminPage.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    } finally {
      await adminContext.close();
    }
  });
});
