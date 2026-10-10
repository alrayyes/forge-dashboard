import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1135: Lighthouse's SEO audit wants a description on every page, and a
// search result or link preview reads it. A sentence about the page, not the
// product name repeated.
const PUBLIC_PAGES = [
  '/login.html',
  '/changelog.html',
  '/disclaimer.html',
  '/privacy.html',
];
const SIGNED_IN_PAGES = [
  '/',
  '/issues.html',
  '/insights.html',
  '/webhooks.html',
  '/settings.html',
];

function description(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      document
        .querySelector('head meta[name="description"]')
        ?.getAttribute('content') ?? '',
  );
}

test.describe('meta descriptions (#1135)', () => {
  for (const path of PUBLIC_PAGES) {
    test(`${path} describes itself`, async ({ page }) => {
      await page.goto(path);
      expect((await description(page)).length).toBeGreaterThan(20);
    });
  }

  test('every signed-in page describes itself, each differently', async ({
    page,
    request,
    baseURL,
  }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      `meta-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'Meta Test User',
    );
    const seen = new Set<string>();
    for (const path of SIGNED_IN_PAGES) {
      await page.goto(path);
      const text = await description(page);
      expect(text.length, `${path} has no description`).toBeGreaterThan(20);
      seen.add(text);
    }
    expect(seen.size).toBe(SIGNED_IN_PAGES.length);
  });
});
