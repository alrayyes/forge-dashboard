import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// The Forgejo token input used to carry "Leave blank to keep the saved token"
// only as its placeholder: clipped to "Leave blank to keep" at 320px, gone on
// focus, and shown even when no token was saved. A saved token now gets a
// permanent helper line tied to the input and a short placeholder; no saved
// token gets neither claim.
// https://github.com/alrayyes/forge-dashboard/issues/3372

async function standIn(page: Page, forgejoTokenSet: boolean) {
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
          forgejoUsername: '',
          forgejoTokenSet,
          webhookToken: 'webhook-token',
          webhookSecret: 'webhook-secret',
          renovateRebaseLabel: '',
          renovateAuthors: [],
          theme: '',
          hideDependencyDashboard: false,
          ignoredTitles: [],
          ignoredTitleCounts: [],
        }),
      }),
  );
}

const widths = [320, 390, 1280];
const schemes = ['light', 'dark'] as const;

for (const saved of [true, false]) {
  for (const width of widths) {
    for (const scheme of schemes) {
      test(`${saved ? 'a saved' : 'no saved'} Forgejo token at ${width}px, ${scheme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await standIn(page, saved);
        await page.goto('/settings.html#connections');

        const input = page.locator('#forgejo-token');
        const helper = page.locator('#forgejo-token-saved');
        await expect(input).toBeVisible();
        const described = (
          (await input.getAttribute('aria-describedby')) ?? ''
        ).split(/\s+/);
        const placeholder = (await input.getAttribute('placeholder')) ?? '';

        if (saved) {
          await expect(page.locator('#forgejo-token-badge')).toBeVisible();
          await expect(helper).toBeVisible();
          await expect(helper).toContainText('Token saved');
          await expect(helper).toContainText('Leave blank to keep');
          expect(described).toContain('forgejo-token-saved');
          expect(placeholder).toBe('Unchanged');

          // The helper sits right under the input, not behind a placeholder.
          const inputBox = await input.boundingBox();
          const helperBox = await helper.boundingBox();
          expect(helperBox!.y).toBeGreaterThanOrEqual(
            inputBox!.y + inputBox!.height,
          );
          // It uses the card's width and is not clipped.
          expect(
            await helper.evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
        } else {
          await expect(page.locator('#forgejo-token-badge')).toBeHidden();
          await expect(helper).toHaveCount(0);
          expect(described).not.toContain('forgejo-token-saved');
          expect(placeholder).not.toMatch(/saved|keep|blank|unchanged/i);
        }

        // The placeholder shows whole: it needs no more room than the input
        // has once its padding is taken off.
        await expect
          .poll(() =>
            input.evaluate((el) => {
              const field = el as HTMLInputElement;
              const style = getComputedStyle(field);
              const ctx = document.createElement('canvas').getContext('2d')!;
              ctx.font = style.font;
              const room =
                field.clientWidth -
                parseFloat(style.paddingLeft) -
                parseFloat(style.paddingRight);
              return ctx.measureText(field.placeholder).width <= room;
            }),
          )
          .toBe(true);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
}
