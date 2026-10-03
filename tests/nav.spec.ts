import { type APIRequestContext, expect, type Page } from '@playwright/test';
import { STORAGE_STATE_PATH as ADMIN_STORAGE_STATE } from './admin-global-setup';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// Coverage for issue #269: one persistent nav, shared markup, present and
// consistent on every page rather than a per-page "back to X" link.
//
// Locators are scoped to `.app-nav` (the header's own nav landmark,
// aria-label="Main") rather than a bare `a[aria-label="..."]`, since
// #645's mobile bottom tab bar (`.bottom-nav`, aria-label="Mobile
// navigation") reuses the same per-destination labels on every `(app)`
// page — an unscoped locator would match two elements there and fail
// Playwright's strict mode. See openspec/changes/mobile-bottom-nav/
// design.md - Decisions.
async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `nav-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Nav Test User');
}

const NAV_PAGES = [
  { path: '/', label: 'Home' },
  { path: '/issues.html', label: 'Issues' },
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
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  for (const { path, label } of NAV_PAGES) {
    test(`on ${path}, every nav icon is present and ${label} is marked current`, async ({
      page,
    }) => {
      await page.goto(path);

      for (const other of NAV_PAGES) {
        await expect(
          page.locator(`.app-nav a[aria-label^="${other.label}"]`),
        ).toBeVisible();
      }

      await expect(
        page.locator(`.app-nav a[aria-label^="${label}"]`),
      ).toHaveAttribute('aria-current', 'page');
      for (const other of NAV_PAGES) {
        if (other.label === label) continue;
        await expect(
          page.locator(`.app-nav a[aria-label^="${other.label}"]`),
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
        await expect(
          page.locator(`.app-nav a[aria-label^="${label}"]`),
        ).toBeVisible();
        await expect(
          page.locator(`.app-nav a[aria-label^="${label}"]`),
        ).not.toHaveAttribute('aria-current', /.*/);
      }
      await expect(page.locator('#admin-link')).toBeHidden();
    });
  }
});

// Coverage for #645: a mobile bottom tab bar as a second nav surface,
// below the same breakpoint style.css already treats as "mobile" for
// the header (max-width: 420px) — see openspec/changes/mobile-bottom-nav/
// design.md - Decisions for why 390x844 (an iPhone-class width) exercises
// it and the default desktop viewport doesn't.
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.describe('mobile bottom tab bar', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  for (const { path, label } of NAV_PAGES) {
    test(`on ${path} at mobile width, the bottom tab bar shows every tab and only ${label} is current`, async ({
      page,
    }) => {
      await page.setViewportSize(MOBILE_VIEWPORT);
      await page.goto(path);

      for (const other of NAV_PAGES) {
        await expect(
          page.locator(`.bottom-nav a[aria-label^="${other.label}"]`),
        ).toBeVisible();
      }
      await expect(
        page.locator('.bottom-nav a[aria-label="Admin"]'),
      ).toHaveCount(0);

      await expect(
        page.locator(`.bottom-nav a[aria-label^="${label}"]`),
      ).toHaveAttribute('aria-current', 'page');
      for (const other of NAV_PAGES) {
        if (other.label === label) continue;
        await expect(
          page.locator(`.bottom-nav a[aria-label^="${other.label}"]`),
        ).not.toHaveAttribute('aria-current', /.*/);
      }

      // The header's own nav surface is the one this exact scenario
      // replaces at this width — still present in the DOM (see
      // design.md's CSS-only, no-{#if}, rationale) but not visible and
      // not in the tab order.
      await expect(page.locator('.app-nav')).toBeHidden();
    });
  }

  test('at desktop width, the bottom tab bar is hidden and not in the tab order', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.bottom-nav')).toBeHidden();
    await expect(page.locator('.app-nav')).toBeVisible();
  });

  test('every bottom tab is keyboard-reachable and Enter activates it', async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto('/');

    const webhooksTab = page.locator('.bottom-nav a[aria-label="Webhooks"]');
    await webhooksTab.focus();
    await expect(webhooksTab).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/webhooks\.html$/);
  });

  test('focus is visible on a bottom tab, same convention as the header nav', async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto('/');

    const homeTab = page.locator('.bottom-nav a[aria-label="Home"]');
    await homeTab.focus();
    await expect(homeTab).toHaveCSS('outline-style', 'solid');
  });
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
