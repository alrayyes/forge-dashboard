import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page } from '@playwright/test';
import { test } from './fixtures';
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

// #813: the page is built from CHANGELOG.md, turned into one same-origin
// JSON file at build time. It makes no request to GitHub or anyone else.
const CHANGELOG = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const CHANGELOG_VERSIONS = [
  ...CHANGELOG.matchAll(/^## \[?(\d+\.\d+\.\d+[^\]\s)]*)/gm),
].map((m) => m[1]);

async function waitForReleasesToSettle(page: Page) {
  await Promise.race([
    page.waitForSelector('.release', { timeout: 15000 }),
    page.waitForSelector('#status.error', { timeout: 15000 }),
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

  test('makes no request to GitHub and reads one same-origin JSON file', async ({
    page,
    baseURL,
  }) => {
    const hosts = new Set<string>();
    const urls: string[] = [];
    page.on('request', (r) => {
      const url = new URL(r.url());
      if (url.protocol.startsWith('http')) {
        hosts.add(url.host);
        urls.push(r.url());
      }
    });
    await page.goto('/releases.html');
    await waitForReleasesToSettle(page);
    await expect(page.locator('.release').first()).toBeVisible();

    // The site-wide font stylesheet is the layout's own, not this page's.
    expect([...hosts].filter((h) => /github/i.test(h))).toEqual([]);
    const changelog = urls.find((u) => u.endsWith('/changelog.json'));
    expect(changelog).toBeDefined();
    expect(new URL(changelog ?? '').host).toBe(new URL(baseURL ?? '').host);
  });

  test('lists every release in CHANGELOG.md, newest first, with its notes', async ({
    page,
  }) => {
    expect(CHANGELOG_VERSIONS.length).toBeGreaterThan(0);
    await page.goto('/releases.html');
    await waitForReleasesToSettle(page);

    await expect(page.locator('.release')).toHaveCount(
      CHANGELOG_VERSIONS.length,
    );
    const titles = await page.locator('.release h2').allInnerTexts();
    expect(titles.map((t) => t.trim())).toEqual(
      CHANGELOG_VERSIONS.map((v) => `v${v}`),
    );
    const first = page.locator('.release').first();
    await expect(first.locator('.release-date')).not.toHaveText('');
    await expect(first.locator('.release-notes li').first()).toBeVisible();
  });

  test('a missing changelog file says so plainly and falls back to nothing', async ({
    page,
  }) => {
    const hosts = new Set<string>();
    page.on('request', (r) => hosts.add(new URL(r.url()).host));
    await page.route('**/changelog.json', (route) =>
      route.fulfill({ status: 404 }),
    );
    await page.goto('/releases.html');
    await waitForReleasesToSettle(page);

    await expect(page.locator('#status.error')).toContainText(
      'Could not load the changelog',
    );
    await expect(page.locator('.release')).toHaveCount(0);
    expect(hosts.has('api.github.com')).toBe(false);
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
