import { expect } from '@playwright/test';
import { test } from './fixtures';

// #1285: an internal tool stays out of search results. The Go tests cover the
// header on every route and robots.txt; this checks the built pages carry the
// meta tag too, which survives a proxy that strips the header.
for (const path of ['/login.html', '/changelog.html', '/privacy.html']) {
  test(`${path} says noindex in the HTML`, async ({ page, baseURL }) => {
    await page.goto(`${baseURL}${path}`);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );
  });
}
