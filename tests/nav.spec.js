const { test, expect } = require('@playwright/test');
const { addVirtualAuthenticator } = require('./webauthn-helper');
const {
  STORAGE_STATE_PATH: ADMIN_STORAGE_STATE,
} = require('./admin-global-setup');

// Coverage for issue #269: one persistent nav, shared markup, present and
// consistent on every page rather than a per-page "back to X" link.
async function registerAndSignIn(page) {
  await addVirtualAuthenticator(page);
  const username = `nav-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', 'Nav Test User');
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

const NAV_PAGES = [
  { path: '/', label: 'Home' },
  { path: '/insights.html', label: 'Insights' },
  { path: '/webhooks.html', label: 'Webhooks' },
  { path: '/settings.html', label: 'Settings' },
];

const NO_SESSION_PAGES = [
  '/releases.html',
  '/disclaimer.html',
  '/privacy.html',
];

test.describe('persistent top nav', () => {
  test.beforeEach(async ({ page }) => {
    await registerAndSignIn(page);
  });

  for (const { path, label } of NAV_PAGES) {
    test(`on ${path}, every nav icon is present and ${label} is marked current`, async ({
      page,
    }) => {
      await page.goto(path);

      for (const other of NAV_PAGES) {
        await expect(
          page.locator(`a[aria-label="${other.label}"]`),
        ).toBeVisible();
      }

      await expect(page.locator(`a[aria-label="${label}"]`)).toHaveAttribute(
        'aria-current',
        'page',
      );
      for (const other of NAV_PAGES) {
        if (other.label === label) continue;
        await expect(
          page.locator(`a[aria-label="${other.label}"]`),
        ).not.toHaveAttribute('aria-current', /.*/);
      }
    });
  }

  test('no page still has a "back to X" link — Home in the nav replaced it', async ({
    page,
  }) => {
    for (const { path } of NAV_PAGES) {
      await page.goto(path);
      await expect(page.getByRole('link', { name: /back to/i })).toHaveCount(0);
    }
  });

  test('the Admin icon stays hidden for a non-admin session, on every page with the nav', async ({
    page,
  }) => {
    for (const { path } of NAV_PAGES) {
      await page.goto(path);
      await expect(page.locator('#admin-link')).toBeHidden();
    }
  });

  for (const path of NO_SESSION_PAGES) {
    test(`${path} renders the same nav even with no session, and marks nothing current`, async ({
      page,
    }) => {
      await page.goto(path);

      for (const { label } of NAV_PAGES) {
        await expect(page.locator(`a[aria-label="${label}"]`)).toBeVisible();
        await expect(
          page.locator(`a[aria-label="${label}"]`),
        ).not.toHaveAttribute('aria-current', /.*/);
      }
      await expect(page.locator('#admin-link')).toBeHidden();
    });
  }
});

test.describe('persistent top nav, admin session', () => {
  test('the Admin icon appears for an admin session on a non-dashboard page too, and is marked current on admin.html', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext({
      storageState: ADMIN_STORAGE_STATE,
    });
    try {
      const adminPage = await adminContext.newPage();

      await adminPage.goto('/settings.html');
      await expect(adminPage.locator('#admin-link')).toBeVisible();

      await adminPage.goto('/admin.html');
      await expect(adminPage.locator('#admin-link')).toHaveAttribute(
        'aria-current',
        'page',
      );
    } finally {
      await adminContext.close();
    }
  });
});
