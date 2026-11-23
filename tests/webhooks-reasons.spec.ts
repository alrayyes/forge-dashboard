import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// A repo with no automatic webhook says why on its row, and a public address
// that can't receive hooks is said once for the page (#4682). The wording per
// reason is unit tested; this proves the wiring once, with axe-core.

function mockDashboard(page: Page, body: Record<string, unknown>) {
  void page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  return page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [],
        issues: [],
        ...body,
      }),
    }),
  );
}

test('a repo with no webhook says why, and a bad origin is said once', async ({
  page,
}) => {
  await mockDashboard(page, {
    webhookOriginProblem: 'the address points at localhost',
    repos: [
      {
        forge: 'github',
        fullName: 'o/down',
        hasWebhook: false,
        canManageWebhooks: true,
        webhookReason: 'forge_unavailable',
      },
      {
        forge: 'github',
        fullName: 'o/refused',
        hasWebhook: false,
        canManageWebhooks: true,
        webhookReason: 'forge_refused',
        webhookReasonDetail: 'Resource not accessible by integration',
        webhookNextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
  });
  await page.goto('/webhooks.html');

  const down = page.locator('tr', { hasText: 'o/down' });
  await expect(down.locator('.webhook-note')).toContainText(
    'The dashboard will try again',
  );

  const refused = page.locator('tr', { hasText: 'o/refused' });
  const note = refused.locator('.webhook-note');
  await expect(note).toContainText('Next try');
  const detailId = await note.getAttribute('aria-describedby');
  await expect(page.locator(`[id="${detailId}"]`)).toContainText(
    'Resource not accessible by integration',
  );

  await expect(page.locator('#webhooks-origin-problem')).toHaveCount(1);
  await expect(page.locator('#webhooks-origin-problem')).toContainText(
    'localhost',
  );

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
