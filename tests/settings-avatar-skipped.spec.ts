import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// An avatar on a host other than the saved Forgejo instance is refused, and
// Settings says so inside the Forgejo card instead of leaving initials
// unexplained. One amber note, hosts in monospace, no dismiss, tied to the URL
// field, absent when nothing is skipped.
// https://github.com/alrayyes/forge-dashboard/issues/3683

async function standIn(page: Page, skipped: string[]) {
  await page.route(
    (url) => url.pathname === '/api/v1/settings',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          githubUsername: '',
          githubTokenSet: false,
          githubAppInstallationId: 0,
          githubAppConfigured: false,
          forgejoUrl: 'https://git.example.com',
          forgejoUsername: 'demo-user',
          forgejoTokenSet: true,
          webhookToken: 'webhook-token',
          webhookSecret: 'webhook-secret',
          renovateRebaseLabel: '',
          renovateAuthors: [],
          theme: '',
          hideDependencyDashboard: false,
          ignoredTitles: [],
          ignoredTitleCounts: [],
          forgejoSkippedAvatarHosts: skipped,
        }),
      }),
  );
}

const widths = [360, 390, 1280];
const note = '#forgejo-avatar-skipped';

for (const [width, scheme] of [
  [360, 'light'],
  [390, 'light'],
  [1280, 'light'],
  [360, 'dark'],
  [1280, 'dark'],
] as const) {
  test(`the note names the skipped host at ${width}px, ${scheme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await standIn(page, ['gravatar.example']);
    await page.goto('/settings.html#connections');

    const urlInput = page.locator('#forgejo-url');
    await expect(page.locator(note)).toBeVisible();
    await expect(page.locator(note)).toHaveText(
      'Avatars from another host were skipped: gravatar.example. Initials are shown instead.',
    );
    await expect(page.locator(`${note} code`)).toHaveText('gravatar.example');
    const family = await page
      .locator(`${note} code`)
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toMatch(/mono/i);
    await expect(urlInput).toHaveAttribute(
      'aria-describedby',
      /(^|\s)forgejo-avatar-skipped(\s|$)/,
    );
    // Inside the Forgejo card, with no dismiss control.
    await expect(
      page.locator('.card', { has: urlInput }).locator(note),
    ).toHaveCount(1);
    await expect(page.locator(`${note} button`)).toHaveCount(0);
    // The words carry the state; the icon is decoration.
    await expect(page.locator(`${note} svg`)).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    // It wraps inside the card, not past it.
    expect(
      await page
        .locator(note)
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('several skipped hosts are listed in one note', async ({ page }) => {
  await standIn(page, ['a.example', 'b.example']);
  await page.goto('/settings.html#connections');

  await expect(page.locator(note)).toHaveText(
    'Avatars from other hosts were skipped: a.example, b.example. Initials are shown instead.',
  );
  await expect(page.locator(`${note} code`)).toHaveCount(2);
});

for (const width of widths) {
  test(`no note and no description when nothing is skipped at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await standIn(page, []);
    await page.goto('/settings.html#connections');

    await expect(page.locator('#forgejo-url')).toBeVisible();
    await expect(page.locator(note)).toHaveCount(0);
    await expect(page.locator('#forgejo-url')).not.toHaveAttribute(
      'aria-describedby',
      /forgejo-avatar-skipped/,
    );

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('on a phone the inputs and buttons stay 44px tall', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await standIn(page, ['gravatar.example']);
  await page.goto('/settings.html#connections');
  await expect(page.locator(note)).toBeVisible();

  for (const sel of [
    '#forgejo-url',
    '#forgejo-token',
    '#forgejo-username',
    'button.token-toggle[data-target="forgejo-token"]',
    '#save-connections-button',
  ]) {
    const box = await page.locator(sel).first().boundingBox();
    expect(box?.height, sel).toBeGreaterThanOrEqual(44);
  }
});
