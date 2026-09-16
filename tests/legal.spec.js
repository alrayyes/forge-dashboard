const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

const PAGES = [
  { path: '/disclaimer.html', title: 'Disclaimer' },
  { path: '/privacy.html', title: 'Privacy' },
];

test.describe('disclaimer and privacy pages', () => {
  for (const { path, title } of PAGES) {
    test(`${path} is reachable without a session`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path.replace('.', '\\.')}$`));
      await expect(page.locator('h1')).toHaveText(title);
    });

    test(`${path} has no axe-core violations at desktop width`, async ({
      page,
    }) => {
      await page.goto(path);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });

    test(`${path} has no axe-core violations and no horizontal scroll at phone width`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(path);

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
  }

  test('the footer links to both from another page, but not from themselves', async ({
    page,
  }) => {
    await page.goto('/login.html');

    const disclaimerLink = page.locator('footer a', { hasText: 'Disclaimer' });
    const privacyLink = page.locator('footer a', { hasText: 'Privacy' });
    await expect(disclaimerLink).toBeVisible();
    await expect(privacyLink).toBeVisible();

    await disclaimerLink.click();
    await expect(page).toHaveURL(/\/disclaimer\.html$/);
    await expect(
      page.locator('footer a', { hasText: 'Disclaimer' }),
    ).toHaveCount(0);
    await expect(
      page.locator('footer a', { hasText: 'Privacy' }),
    ).toBeVisible();

    await page.locator('footer a', { hasText: 'Privacy' }).click();
    await expect(page).toHaveURL(/\/privacy\.html$/);
    await expect(page.locator('footer a', { hasText: 'Privacy' })).toHaveCount(
      0,
    );
    await expect(
      page.locator('footer a', { hasText: 'Disclaimer' }),
    ).toBeVisible();
  });

  test('disclaimer links to the licence, privacy names the webhook credentials doc', async ({
    page,
  }) => {
    await page.goto('/disclaimer.html');
    await expect(page.locator('a[href*="LICENSE"]').first()).toBeVisible();

    await page.goto('/privacy.html');
    await expect(
      page.locator('a[href*="docs/webhooks.md"]').first(),
    ).toBeVisible();
  });
});
