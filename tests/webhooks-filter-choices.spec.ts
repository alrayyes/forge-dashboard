import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #1427: a filter offers only choices that exist in the results. On the
// webhooks page that is the forge buttons and the status select: a forge with
// no tracked repo, or a status no repo has, isn't offered, and what the other
// filters leave out is left out of the choices too.
// https://github.com/alrayyes/forge-dashboard/issues/1427

// The filters are saved on the server now, and these tests share one: keep what one
// picks from becoming the next test's starting point.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/settings/filter-state', (route: Route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{}',
        })
      : route.fulfill({ status: 204 }),
  );
});

function mockDashboard(
  page: Page,
  repos: Record<string, unknown>[],
  forges: Record<string, unknown>[] = [],
) {
  return page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges,
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
  test('the forge buttons are named by the label the API sends (#3976)', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [
        { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
        { forge: 'forgejo', fullName: 'alrayyes/b', hasWebhook: true },
      ],
      [
        { forge: 'github', reachable: true, capabilities: { label: 'Octo' } },
        { forge: 'forgejo', reachable: true, capabilities: { label: 'Berg' } },
      ],
    );
    await page.goto('/webhooks.html');

    const bar = page.locator('.webhooks-filter-bar');
    await expect(bar.getByLabel('Octo')).toHaveCount(1);
    await expect(bar.getByLabel('Berg')).toHaveCount(1);
    await expect(bar.getByLabel('GitHub')).toHaveCount(0);
  });

  test('a forge the API reports beyond the two shipped gets a button (#3976)', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [
        { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
        { forge: 'gitea', fullName: 'alrayyes/b', hasWebhook: true },
      ],
      [
        { forge: 'github', reachable: true, capabilities: { label: 'GitHub' } },
        { forge: 'gitea', reachable: true, capabilities: { label: 'Gitea' } },
      ],
    );
    await page.goto('/webhooks.html');

    await expect(forgeRadio(page, 'gitea')).toHaveCount(1);
    await expect(
      page.locator('.webhooks-filter-bar').getByLabel('Gitea'),
    ).toHaveCount(1);
  });

  test('the buttons keep the forge order, and the picked one is checked (#3976)', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [
        { forge: 'gitea', fullName: 'alrayyes/c', hasWebhook: true },
        { forge: 'forgejo', fullName: 'alrayyes/b', hasWebhook: true },
        { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      ],
      [
        { forge: 'github', reachable: true, capabilities: { label: 'GitHub' } },
        {
          forge: 'forgejo',
          reachable: true,
          capabilities: { label: 'Forgejo' },
        },
        { forge: 'gitea', reachable: true, capabilities: { label: 'Gitea' } },
      ],
    );
    await page.goto('/webhooks.html');
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(3);

    const bar = page.locator('.webhooks-filter-bar');
    await expect(bar.locator('.forge-segmented label')).toHaveText([
      'All',
      'GitHub',
      'Forgejo',
      'Gitea',
    ]);
    await forgeRadio(page, 'forgejo').check();
    await expect(forgeRadio(page, 'forgejo')).toBeChecked();
    await expect(forgeRadio(page, 'github')).not.toBeChecked();
    await expect(forgeRadio(page, 'gitea')).not.toBeChecked();
  });

  test('a registered forge with no repo gets no button, and the others stay (#3976)', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [
        { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
        { forge: 'forgejo', fullName: 'alrayyes/b', hasWebhook: true },
      ],
      [
        { forge: 'github', reachable: true, capabilities: { label: 'GitHub' } },
        {
          forge: 'forgejo',
          reachable: true,
          capabilities: { label: 'Forgejo' },
        },
        { forge: 'gitea', reachable: true, capabilities: { label: 'Gitea' } },
      ],
    );
    await page.goto('/webhooks.html');
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);

    await expect(forgeRadio(page, 'github')).toHaveCount(1);
    await expect(forgeRadio(page, 'forgejo')).toHaveCount(1);
    await expect(forgeRadio(page, 'gitea')).toHaveCount(0);
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

  test('a status you picked stays visible when the other filters leave it nothing, so you can clear it', async ({
    page,
  }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      { forge: 'forgejo', fullName: 'ryan/b', hasWebhook: false },
    ]);
    await page.goto('/webhooks.html');
    await page.selectOption('#webhooks-status-filter', 'pending');

    // Only a confirmed repo matches "alrayyes", but Not yet stays, selected.
    await page.locator('#webhooks-repo-filter').fill('alrayyes');
    await expect(page.locator('#webhooks-no-results')).toBeVisible();
    await expect(page.locator('#webhooks-status-filter')).toHaveValue(
      'pending',
    );
    expect(await statusValues(page)).toEqual(['', 'confirmed', 'pending']);

    await page.selectOption('#webhooks-status-filter', '');
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
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
