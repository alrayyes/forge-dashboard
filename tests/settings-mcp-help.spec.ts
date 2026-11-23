import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { test } from './server-fixture';

// The API tokens card tells the user how to connect the MCP endpoint to an AI
// client, with the URL built from the origin the page is open on.
// https://github.com/alrayyes/forge-dashboard/issues/4660

const axeTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('Use with an AI client', () => {
  test('shows this page origin in the MCP URL and a placeholder token', async ({
    page,
    baseURL,
  }) => {
    await page.goto('/settings.html#api-tokens');
    const section = page.getByRole('group', { name: 'Use with an AI client' });
    await expect(section).toBeVisible();
    await expect(section.locator('#mcp-url')).toHaveValue(
      `${new URL(baseURL as string).origin}/api/v1/mcp`,
    );
    await expect(section).toContainText('Authorization: Bearer <token>');
    await expect(section).toContainText('claude mcp add --transport http');
    await expect(section).toContainText('Request headers');
  });

  test('the copy button puts the URL on the clipboard', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/settings.html#api-tokens');
    const copy = page.getByRole('button', { name: 'Copy MCP URL' });
    await copy.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#mcp-copy-status')).toHaveText('Copied.');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(`${new URL(baseURL as string).origin}/api/v1/mcp`);
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [320, 390, 1280]) {
      test(`has no axe violations or overflow at ${width}px, ${scheme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/settings.html#api-tokens');
        await expect(page.locator('#mcp-url')).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(axeTags)
          .analyze();
        expect(results.violations).toEqual([]);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        expect(overflow).toBe(false);
      });
    }
  }
});
