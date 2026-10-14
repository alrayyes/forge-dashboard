import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1427: a filter offers only choices that exist in the results. On the
// webhooks page that is the forge buttons and the status select: a forge with
// no tracked repo, or a status no repo has, isn't offered, and what the other
// filters leave out is left out of the choices too.
// https://github.com/alrayyes/forge-dashboard/issues/1427

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `webhooks-choices-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Webhooks Choices');
}

function mockDashboard(page: Page, repos: Record<string, unknown>[]) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos,
      }),
    }),
  );
}

const forgeRadio = (page: Page, value: string) =>
  page.locator(
    `.webhooks-filter-bar input[data-filter="forge"][value="${value}"]`,
  );
const statusValues = (page: Page) =>
  page
    .locator('#webhooks-status-filter option')
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));

test.describe('webhooks filter choices (#1427)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('a forge with no tracked repo is not offered, and neither is a status no repo has', async ({
    page,
  }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      { forge: 'github', fullName: 'alrayyes/b', hasWebhook: true },
    ]);
    await page.goto('/webhooks.html');
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);

    await expect(forgeRadio(page, 'github')).toHaveCount(1);
    await expect(forgeRadio(page, 'forgejo')).toHaveCount(0);
    expect(await statusValues(page)).toEqual(['', 'confirmed']);
  });

  test('both are offered when the repos have both', async ({ page }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      { forge: 'forgejo', fullName: 'alrayyes/b', hasWebhook: false },
    ]);
    await page.goto('/webhooks.html');
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);

    await expect(forgeRadio(page, 'github')).toHaveCount(1);
    await expect(forgeRadio(page, 'forgejo')).toHaveCount(1);
    expect(await statusValues(page)).toEqual(['', 'confirmed', 'pending']);
  });

  test('the choices follow the other filters: typing a repo that only one forge has drops the other forge', async ({
    page,
  }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/app', hasWebhook: true },
      { forge: 'forgejo', fullName: 'ryan/infra', hasWebhook: false },
    ]);
    await page.goto('/webhooks.html');
    await expect(forgeRadio(page, 'forgejo')).toHaveCount(1);

    await page.locator('#webhooks-repo-filter').fill('infra');

    await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
    await expect(forgeRadio(page, 'github')).toHaveCount(0);
    await expect(forgeRadio(page, 'forgejo')).toHaveCount(1);
    expect(await statusValues(page)).toEqual(['', 'pending']);

    await page.locator('#webhooks-repo-filter').fill('');
    await expect(forgeRadio(page, 'github')).toHaveCount(1);
  });

  test('a forge you picked stays visible when the other filters leave it nothing, so you can clear it', async ({
    page,
  }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      { forge: 'forgejo', fullName: 'ryan/b', hasWebhook: false },
      { forge: 'github', fullName: 'alrayyes/c', hasWebhook: false },
    ]);
    await page.goto('/webhooks.html');
    await forgeRadio(page, 'forgejo').check();

    // No Forgejo repo matches "alrayyes", but Forgejo stays, checked.
    await page.locator('#webhooks-repo-filter').fill('alrayyes');
    await expect(page.locator('#webhooks-no-results')).toBeVisible();
    await expect(forgeRadio(page, 'forgejo')).toBeChecked();
    await expect(forgeRadio(page, 'github')).toHaveCount(1);

    await forgeRadio(page, '').check();
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);
    await expect(forgeRadio(page, 'forgejo')).toHaveCount(0);
  });

  test('has no axe-core violations with a single forge', async ({ page }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
    ]);
    await page.goto('/webhooks.html');
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
