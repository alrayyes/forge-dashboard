import AxeBuilder from '@axe-core/playwright';
import { expect, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The Webhooks page names a forge, and reads its capability flags, from what
// the dashboard read reported, so a forge the web has never heard of shows its
// own label and its own hint when the page is the first one opened (#4719).
// https://github.com/alrayyes/forge-dashboard/issues/4719

test('a forge the web never heard of is named and hinted from its capabilities', async ({
  page,
}) => {
  const gitea = forgeHealth('github', {
    forge: 'gitea',
    capabilities: {
      ...forgeHealth('github').capabilities,
      label: 'Gitea',
      reportsRepoPermissions: true,
    },
  });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [gitea],
        pullRequests: [],
        issues: [],
        repos: [
          {
            forge: 'gitea',
            fullName: 'lab/widget',
            hasWebhook: false,
            canManageWebhooks: false,
            webhookLockedByConnection: true,
          },
        ],
      }),
    }),
  );
  await page.goto('/webhooks.html');

  const row = page.locator('tr', { hasText: 'lab/widget' });
  await expect(row.locator('.forge-badge')).toContainText('Gitea');
  await expect(row.locator('.webhook-locked-reason')).toContainText(
    "Gitea didn't report your access on this repo",
  );

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
