import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './server-fixture';

test.describe('passkey login', () => {
  test('an invite link shows sign-in only once a user exists', async ({
    page,
    context,
  }) => {
    await context.clearCookies();

    await page.goto('/login.html?invite=anything&username=someone');

    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.locator('#register-form')).toHaveCount(0);
    await expect(page.locator('#show-register')).toHaveCount(0);
  });

  test('has no axe-core violations at desktop width', async ({ page }) => {
    await page.goto('/login.html');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login.html');

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
