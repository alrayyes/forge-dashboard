import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `releases-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'Releases Test User',
  );
}

// The page's actual content comes from a real call to GitHub's public
// releases API (see releases.js) — not mocked, but also not something a
// test should hard-assert the exact shape of: a real, independent
// third-party API can rate-limit or have a bad moment, and releases.js
// is written to degrade to a visible fallback link rather than an error
// banner or a broken page when that happens. This waits for either
// outcome rather than assuming the happy path.
async function waitForReleasesToSettle(page: Page) {
  await Promise.race([
    page.waitForSelector('.release', { timeout: 15000 }),
    page.waitForSelector('#status.error', { timeout: 15000 }),
    page.waitForSelector('#release-empty:not([hidden])', { timeout: 15000 }),
  ]);
}

test.describe('release history page', () => {
  test('reachable without a session, unlike the dashboard itself', async ({
    page,
  }) => {
    await page.goto('/releases.html');
    await expect(page).toHaveURL(/\/releases\.html$/);
    await expect(page.locator('.releases-header h1')).toHaveText(
      'Release history',
    );
  });

  test('loads real release data from GitHub, or falls back to a visible link rather than breaking', async ({
    page,
  }) => {
    await page.goto('/releases.html');
    await waitForReleasesToSettle(page);

    const releaseCount = await page.locator('.release').count();
    if (releaseCount > 0) {
      // The real, expected case for this repo, which has published
      // releases — each one names a version and links to it.
      const first = page.locator('.release').first();
      await expect(first.locator('h2 a')).toHaveAttribute(
        'href',
        /github\.com/,
      );
      await expect(first.locator('.release-date')).not.toHaveText('');
    } else {
      await expect(page.locator('#status')).toContainText(/could not load/i);
      await expect(page.locator('#status a')).toHaveAttribute(
        'href',
        /github\.com\/alrayyes\/forge-dashboard\/releases/,
      );
    }
  });

  // #786: the footer's version is the way in to this page. CI builds a dev
  // binary (plain text, no link), so a released version is mocked.
  test('the footer version links here from other pages, and is plain text on this one', async ({
    page,
    request,
    baseURL,
  }) => {
    await registerAndSignIn(page, request, baseURL);
    await page.route('**/api/version', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ version: '1.2.3' }),
      }),
    );
    await page.reload();

    const versionLink = page.locator('#footer-version a', {
      hasText: 'v1.2.3',
    });
    await expect(versionLink).toHaveAttribute('href', '/releases.html');
    await versionLink.click();
    await expect(page).toHaveURL(/\/releases\.html$/);

    await expect(page.locator('#footer-version')).toContainText('v1.2.3');
    await expect(page.locator('#footer-version a')).toHaveCount(0);
    await expect(page.locator('#footer-version')).not.toContainText(
      'Release history',
    );
  });

  test('has no axe-core violations at desktop width', async ({ page }) => {
    await page.goto('/releases.html');
    await waitForReleasesToSettle(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/releases.html');
    await waitForReleasesToSettle(page);

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
