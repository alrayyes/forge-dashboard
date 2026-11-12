import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { test } from './server-fixture';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const PAGES = [
  { path: '/disclaimer.html', title: 'Disclaimer' },
  { path: '/privacy.html', title: 'Privacy' },
];

test.describe('disclaimer and privacy pages', () => {
  for (const { path, title } of PAGES) {
    test(`${path} is reachable without a session and has no axe-core violations or horizontal scroll at desktop and phone width`, async ({
      page,
    }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path.replace('.', '\\.')}$`));
      await expect(page.locator('.legal-header h1')).toHaveText(title);

      const desktop = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .analyze();
      expect(desktop.violations).toEqual([]);

      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      const phone = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(phone.violations).toEqual([]);

      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      const clientWidth = await page.evaluate(
        () => document.documentElement.clientWidth,
      );
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    });
  }

  // #1109: Svelte trims whitespace around {#if} blocks, which ran the
  // separators into the words before them ("dev build· Disclaimer· Privacy").
  test('the footer separates its items with a space on each side', async ({
    page,
  }) => {
    await page.goto('/login.html');
    // A separator and its link are joined by a no-break space, so they never
    // split across two lines; it reads as a space.
    const text = await page
      .locator('footer')
      .evaluate((el) => (el as HTMLElement).innerText.replace(/\u00a0/g, ' '));
    expect(text).toContain('dev build · Disclaimer · Privacy');
  });

  // The owner decided (#1679) that the footer keeps the link to the page
  // you're on and marks it current, instead of dropping it.
  test('the footer keeps both links on each page and marks the current one', async ({
    page,
  }) => {
    await page.goto('/login.html');

    const disclaimerLink = page.locator('footer a', { hasText: 'Disclaimer' });
    const privacyLink = page.locator('footer a', { hasText: 'Privacy' });
    await expect(disclaimerLink).toBeVisible();
    await expect(privacyLink).toBeVisible();
    await expect(disclaimerLink).not.toHaveAttribute('aria-current', 'page');

    await disclaimerLink.click();
    await expect(page).toHaveURL(/\/disclaimer\.html$/);
    await expect(disclaimerLink).toHaveAttribute('aria-current', 'page');
    await expect(privacyLink).toBeVisible();
    await expect(privacyLink).not.toHaveAttribute('aria-current', 'page');

    await privacyLink.click();
    await expect(page).toHaveURL(/\/privacy\.html$/);
    await expect(privacyLink).toHaveAttribute('aria-current', 'page');
    await expect(disclaimerLink).toBeVisible();
    await expect(disclaimerLink).not.toHaveAttribute('aria-current', 'page');
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
