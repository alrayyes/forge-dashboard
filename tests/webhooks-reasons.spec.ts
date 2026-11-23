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
      {
        forge: 'github',
        fullName: 'o/locked',
        hasWebhook: false,
        canManageWebhooks: false,
        webhookReason: 'no_permission',
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
  // The origin is said once for the page, never repeated on a row.
  await expect(page.locator('tbody')).not.toContainText('localhost');

  // A repo the token can't administer keeps its lock text and gets no note.
  const locked = page.locator('tr', { hasText: 'o/locked' });
  await expect(locked).toBeVisible();
  await expect(locked.locator('.webhook-note')).toHaveCount(0);

  // Focus reveals the detail as a popover: nothing below it moves, and Esc
  // hides it while focus stays put (WCAG 1.4.13).
  const detail = page.locator(`[id="${detailId}"]`);
  const before = await locked.boundingBox();
  await note.focus();
  await expect(detail).toBeVisible();
  const box = await detail.boundingBox();
  expect(box?.width).toBeGreaterThan(100);
  expect((await locked.boundingBox())?.y).toBe(before?.y);
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await detail.boundingBox())?.width ?? 0)
    .toBeLessThanOrEqual(1);
  await expect(note).toBeFocused();

  // Esc also hides it when only the pointer is on the note and focus is
  // elsewhere (WCAG 1.4.13).
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await note.hover();
  await expect
    .poll(async () => (await detail.boundingBox())?.width ?? 0)
    .toBeGreaterThan(100);
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await detail.boundingBox())?.width ?? 0)
    .toBeLessThanOrEqual(1);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('on a phone the reason stays reachable and the page does not scroll sideways', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await mockDashboard(page, {
    repos: [
      {
        forge: 'github',
        fullName: 'o/refused',
        hasWebhook: false,
        canManageWebhooks: true,
        webhookReason: 'forge_refused',
        webhookReasonDetail: 'Resource not accessible by integration',
      },
    ],
  });
  await page.goto('/webhooks.html');

  const note = page.locator('.webhook-note');
  await note.focus();
  await expect(
    page.locator(`[id="${await note.getAttribute('aria-describedby')}"]`),
  ).toBeVisible();

  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
