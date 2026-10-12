import { expect } from '@playwright/test';
import { test } from './fixtures';

// #1285: an internal tool stays out of search results. The Go test covers the
// header on every route; this checks the built pages carry the meta tag too,
// which survives a proxy that strips the header.
for (const path of ['/login.html', '/changelog.html', '/privacy.html']) {
  test(`${path} says noindex in the header and the HTML`, async ({
    page,
    baseURL,
  }) => {
    const response = await page.goto(`${baseURL}${path}`);
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );
  });
}

test('robots.txt does not disallow crawling, so the noindex gets read', async ({
  request,
  baseURL,
}) => {
  const response = await request.get(`${baseURL}/robots.txt`);
  expect(await response.text()).not.toMatch(/Disallow:\s*\//);
});
