import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';
import { rateLimit } from './severity-stand-in';

// Times show in one zone, with its name, everywhere (#996). The zone is the
// saved setting when there is one, otherwise the browser's own. Browsers
// that report UTC to every page (Firefox's resistFingerprinting, Tor
// Browser) are why there is a setting at all.
// https://github.com/alrayyes/forge-dashboard/issues/996
//
// Intl names a zone by the viewer's locale: en-GB writes Europe/Amsterdam as
// "CEST", en-US as "GMT+2". Every test pins the locale, so the labels
// asserted here are the ones that locale produces.

const NOW = new Date('2026-10-05T10:00:00Z');
const TODAY_RESET = '2026-10-05T12:00:00Z';
const TOMORROW_RESET = '2026-10-06T12:00:00Z';

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `timezone-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Timezone User');
}

// The server's saved zone, stood in for so a test can say what it was.
function mockSavedZone(page: Page, timezone: string) {
  return page.route('**/api/settings/timezone', (route: Route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ timezone }),
        })
      : route.continue(),
  );
}

function mockExhausted(page: Page, resetsAt: string) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: NOW.toISOString(),
        forges: [
          {
            forge: 'github',
            reachable: true,
            repoCount: 1,
            rateLimitREST: rateLimit(5000, 0, resetsAt),
          },
        ],
        pullRequests: [],
        issues: [],
      }),
    }),
  );
}

async function showResetOnDashboard(page: Page, resetsAt: string) {
  await page.clock.setFixedTime(NOW);
  await mockExhausted(page, resetsAt);
  await page.goto('/');
}

const header = (page: Page) => page.locator('#forge-health');

test.describe('times in the viewer zone (#996)', () => {
  test.use({ locale: 'en-GB', timezoneId: 'Europe/Amsterdam' });

  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('with no saved zone, the browser zone is used and named', async ({
    page,
  }) => {
    await mockSavedZone(page, '');
    await showResetOnDashboard(page, TODAY_RESET);
    await expect(header(page)).toContainText('resets 14:00 CEST');
  });

  test('a saved zone shows its own time and name', async ({ page }) => {
    await mockSavedZone(page, 'UTC');
    await showResetOnDashboard(page, TODAY_RESET);
    await expect(header(page)).toContainText('resets 12:00 UTC');
  });

  test('a time on another day carries its date', async ({ page }) => {
    await mockSavedZone(page, '');
    await showResetOnDashboard(page, TOMORROW_RESET);
    await expect(header(page)).toContainText(/resets 6 Oct.*14:00 CEST/);
  });

  test('a zone that arrives after the first draw redraws the time without a reload', async ({
    page,
  }) => {
    let answer: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await page.route('**/api/settings/timezone', async (route: Route) => {
      await gate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ timezone: 'UTC' }),
      });
    });
    await showResetOnDashboard(page, TODAY_RESET);
    await expect(header(page)).toContainText('resets 14:00 CEST');
    answer();
    await expect(header(page)).toContainText('resets 12:00 UTC');
  });

  test('an answer that fails falls back to the browser zone', async ({
    page,
  }) => {
    await page.route('**/api/settings/timezone', (route) =>
      route.fulfill({ status: 500, body: 'nope' }),
    );
    await showResetOnDashboard(page, TODAY_RESET);
    await expect(header(page)).toContainText('resets 14:00 CEST');
  });

  test('the webhooks page names the zone too', async ({ page }) => {
    await mockSavedZone(page, 'UTC');
    await page.clock.setFixedTime(NOW);
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: NOW.toISOString(),
          forges: [
            {
              forge: 'github',
              reachable: true,
              repoCount: 1,
              rateLimitREST: rateLimit(5000, 0, TODAY_RESET),
            },
          ],
          repos: [
            {
              forge: 'github',
              fullName: 'alrayyes/forge-dashboard',
              hasWebhook: false,
              canManageWebhooks: true,
            },
          ],
          pullRequests: [],
          issues: [],
        }),
      }),
    );
    await page.goto('/webhooks.html');
    await expect(page.locator('#webhooks-rows')).toContainText(
      'Rate limit exhausted · resets 12:00 UTC',
    );
  });
});

test.describe('a browser that reports UTC (#996)', () => {
  test.use({ locale: 'en-GB', timezoneId: 'UTC' });

  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('a saved zone overrides it', async ({ page }) => {
    await mockSavedZone(page, 'Europe/Amsterdam');
    await showResetOnDashboard(page, TODAY_RESET);
    await expect(header(page)).toContainText('resets 14:00 CEST');
  });
});

test.describe('the time zone control on Settings (#996)', () => {
  test.use({ locale: 'en-GB', timezoneId: 'Europe/Amsterdam' });

  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('defaults to the browser zone, named in the option', async ({
    page,
  }) => {
    await page.goto('/settings.html');
    const select = page.getByLabel('Time zone');
    await expect(select).toHaveValue('');
    await expect(select.locator('option[value=""]')).toHaveText(
      'Browser default (Europe/Amsterdam)',
    );
    await expect(select.locator('option[value="UTC"]')).toHaveCount(1);
  });

  test('saves at once, previews the zone, and the dashboard picks it up', async ({
    page,
  }) => {
    await page.goto('/settings.html');
    const preview = page.locator('#timezone-preview');
    await expect(preview).toContainText('CEST');

    const saved = page.waitForRequest(
      (req) =>
        req.url().includes('/api/settings/timezone') && req.method() === 'PUT',
    );
    await page.getByLabel('Time zone').selectOption('UTC');
    expect((await saved).postDataJSON()).toEqual({ timezone: 'UTC' });
    await expect(preview).toContainText(/\d{2}:\d{2} UTC/);
    await expect(page.locator('#timezone-status')).toHaveText('');

    await page.reload();
    await expect(page.getByLabel('Time zone')).toHaveValue('UTC');

    await showResetOnDashboard(page, TODAY_RESET);
    await expect(header(page)).toContainText('resets 12:00 UTC');
  });

  test('choosing the browser default saves an empty name', async ({ page }) => {
    await page.goto('/settings.html');
    await page.getByLabel('Time zone').selectOption('UTC');
    await expect(page.locator('#timezone-preview')).toContainText('UTC');

    const saved = page.waitForRequest(
      (req) =>
        req.url().includes('/api/settings/timezone') && req.method() === 'PUT',
    );
    await page.getByLabel('Time zone').selectOption('');
    expect((await saved).postDataJSON()).toEqual({ timezone: '' });
    await expect(page.locator('#timezone-preview')).toContainText('CEST');
  });

  test('a refused name shows a failure line and keeps the old zone', async ({
    page,
  }) => {
    await page.route('**/api/settings/timezone', (route: Route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'unknown time zone' }),
          })
        : route.continue(),
    );
    await page.goto('/settings.html');
    await page.getByLabel('Time zone').selectOption('UTC');
    await expect(page.locator('#timezone-status')).toHaveText(
      'Could not save time zone.',
    );
    await expect(page.getByLabel('Time zone')).toHaveValue('');
    await expect(page.locator('#timezone-preview')).toContainText('CEST');
  });
});
