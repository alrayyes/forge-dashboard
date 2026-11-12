import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// The GitHub token kept its "leave blank to keep the saved one" instruction in
// a paragraph above the field, while the Forgejo token says it in a helper
// line under the input. Both now use the helper line and tie it to the input
// with aria-describedby, next to the field hint and any field error.
// https://github.com/alrayyes/forge-dashboard/issues/3409

function settings(githubTokenSet: boolean, forgejoTokenSet: boolean) {
  return {
    githubUsername: '',
    githubTokenSet,
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
    ignoredCounts: [],
  };
}

async function standIn(
  page: Page,
  saved: { github: boolean; forgejo: boolean },
  put?: { status: number; body: unknown },
) {
  await page.route(
    (url) => url.pathname === '/api/v1/settings',
    (route) => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({
          status: put?.status ?? 200,
          contentType: 'application/json',
          body: JSON.stringify(put?.body ?? settings(true, saved.forgejo)),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(settings(saved.github, saved.forgejo)),
      });
    },
  );
}

const tokens = [
  { name: 'GitHub', prefix: 'github', empty: 'ghp_…' },
  { name: 'Forgejo', prefix: 'forgejo', empty: 'Paste a token' },
] as const;

const axeTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const ids = (value: string | null) =>
  (value ?? '').split(/\s+/).filter(Boolean);

for (const { name, prefix, empty } of tokens) {
  const both = { github: true, forgejo: true };
  const none = { github: false, forgejo: false };

  test.describe(`${name} token saved hint`, () => {
    test('a saved token gets a helper line tied to the input', async ({
      page,
    }) => {
      await standIn(page, both);
      await page.goto('/settings.html#connections');
      const input = page.locator(`#${prefix}-token`);
      const helper = page.locator(`#${prefix}-token-saved`);
      await expect(helper).toBeVisible();
      await expect(helper).toContainText('Token saved');
      await expect(helper).toContainText('Leave blank to keep');
      await expect(input).toHaveAttribute('placeholder', 'Unchanged');
      expect(ids(await input.getAttribute('aria-describedby'))).toContain(
        `${prefix}-token-saved`,
      );
    });

    test('no saved token shows no helper', async ({ page }) => {
      await standIn(page, none);
      await page.goto('/settings.html#connections');
      const input = page.locator(`#${prefix}-token`);
      await expect(input).toBeVisible();
      await expect(page.locator(`#${prefix}-token-saved`)).toHaveCount(0);
      await expect(input).toHaveAttribute('placeholder', empty);
      expect(ids(await input.getAttribute('aria-describedby'))).not.toContain(
        `${prefix}-token-saved`,
      );
    });

    test('a saved token with a field error describes the input by saved, hint and error', async ({
      page,
    }) => {
      await standIn(page, both, {
        status: 400,
        body: { error: 'That token was refused.', field: `${prefix}Token` },
      });
      await page.goto('/settings.html#connections');
      await page.fill(`#${prefix}-token`, 'not-a-token');
      await page.click('#save-connections-button');
      await expect(page.locator(`#${prefix}-token-error`)).toBeVisible();
      const input = page.locator(`#${prefix}-token`);
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(ids(await input.getAttribute('aria-describedby'))).toEqual([
        `${prefix}-token-saved`,
        `${prefix}-token-hint`,
        `${prefix}-token-error`,
      ]);
    });

    test('saving a first token switches the helper and placeholder with no reload', async ({
      page,
    }) => {
      await standIn(page, none, {
        status: 200,
        body: settings(true, true),
      });
      await page.goto('/settings.html#connections');
      const input = page.locator(`#${prefix}-token`);
      await expect(page.locator(`#${prefix}-token-saved`)).toHaveCount(0);
      await input.fill('a-fresh-token');
      await page.click('#save-connections-button');
      await expect(page.locator('#connections-status')).toHaveText('Saved.');
      await expect(page.locator(`#${prefix}-token-saved`)).toBeVisible();
      await expect(input).toHaveAttribute('placeholder', 'Unchanged');
      expect(ids(await input.getAttribute('aria-describedby'))).toContain(
        `${prefix}-token-saved`,
      );
    });

    test('a saved token has no axe violations', async ({ page }) => {
      await standIn(page, both);
      await page.goto('/settings.html#connections');
      await expect(page.locator(`#${prefix}-token-saved`)).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(axeTags)
        .analyze();
      expect(results.violations).toEqual([]);
    });

    test('a saved token with a field error has no axe violations', async ({
      page,
    }) => {
      await standIn(page, both, {
        status: 400,
        body: { error: 'That token was refused.', field: `${prefix}Token` },
      });
      await page.goto('/settings.html#connections');
      await page.fill(`#${prefix}-token`, 'not-a-token');
      await page.click('#save-connections-button');
      await expect(page.locator(`#${prefix}-token-error`)).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(axeTags)
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });
}
