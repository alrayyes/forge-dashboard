import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `ci-pill-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'CI Pill Test');
}

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: false,
    ...overrides,
  };
}

function mockDashboard(page: Page, pr: unknown) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pr],
        issues: [],
      }),
    }),
  );
}

function mockChecks(page: Page) {
  return page.route('**/api/pull-requests/checks*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        checks: [{ name: 'build', state: 'success', url: 'https://x.test/1' }],
      }),
    }),
  );
}

test.describe('CI pill opens the pipeline (#1139)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('the pill is a button naming the status and the destination, and opens the panel', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ ci: 'failure' }));
    await mockChecks(page);
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    const pill = row.getByRole('button', { name: 'Failing. Open pipeline' });
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('Failing');
    await expect(
      row.getByRole('button', { name: /View pipeline/ }),
    ).toHaveCount(0);
    const box = await pill.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(24);

    await pill.click();
    await expect(
      page.getByRole('dialog', { name: 'Pipeline checks' }),
    ).toBeVisible();
  });

  test('the pill opens the panel from the keyboard and focus returns to it', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await mockChecks(page);
    await page.reload();

    const pill = page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: /Open pipeline/ });
    await pill.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toBeVisible();
    await expect(
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
        .then((r) => r.violations),
    ).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(pill).toBeFocused();
  });

  test('a row with no CI draws no pill button', async ({ page }) => {
    await mockDashboard(page, makePR({ ci: 'none' }));
    await page.reload();
    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: /Open pipeline/ }),
    ).toHaveCount(0);
  });

  test('a lone extra action is shown directly, with no More actions menu', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockDashboard(
      page,
      makePR({ allowedActions: [{ action: 'merge' }, { action: 'close' }] }),
    );
    await page.reload();
    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'More actions' })).toHaveCount(
      0,
    );
    await row.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(
      row.getByRole('button', { name: /Confirm close/ }),
    ).toBeVisible();
    await expect(
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
        .then((r) => r.violations),
    ).toEqual([]);
  });

  test('a row with two or more extra actions keeps More actions', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ author: 'dependabot' }));
    await page.reload();
    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('group', { name: 'More actions' });
    expect(await menu.getByRole('button').count()).toBeGreaterThanOrEqual(2);
    await expect(
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
        .then((r) => r.violations),
    ).toEqual([]);
  });
});
