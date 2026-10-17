import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// A "Clear filters" control on the Webhooks page, the one the other list pages
// have. It shows only while a filter differs from its default, resets forge,
// repo, status and sort, and the cleared state is saved like any other change.
// https://github.com/alrayyes/forge-dashboard/issues/1811

const REPOS = [
  { forge: 'github', fullName: 'acme/app', hasWebhook: true },
  { forge: 'forgejo', fullName: 'acme/infra', hasWebhook: false },
].map((r) => ({
  ...r,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
  canManageWebhooks: true,
}));

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos: REPOS,
      }),
    }),
  );
  await page.goto('/webhooks.html');
  await expect(page.locator('#webhooks-rows tr').first()).toBeVisible();
}

async function signIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  await registerViaInvite(
    page,
    request,
    baseURL,
    `webhooks-clear-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    'Webhooks Clear',
  );
}

const clear = (page: Page) =>
  page.getByRole('button', { name: 'Clear filters' });
const serverCopy = async (page: Page) => {
  const body = await (
    await page.request.get('/api/settings/filter-state')
  ).json();
  return (body?.webhooks ?? {}) as Record<string, string>;
};
const cookieCopy = async (page: Page) => {
  const c = (await page.context().cookies()).find(
    (x) => x.name === 'forge-board-filters',
  );
  return ((c ? JSON.parse(decodeURIComponent(c.value)) : {}).webhooks ??
    {}) as Record<string, string>;
};

const DEFAULTS = {
  forge: '',
  repo: '',
  status: '',
  sort: 'fullName',
  dir: 'asc',
};

test.describe('webhooks: Clear filters', () => {
  test('shows only while a filter differs from its default', async ({
    page,
    request,
    baseURL,
  }) => {
    await signIn(page, request, baseURL);
    await open(page);
    await expect(clear(page)).toHaveCount(0);

    await page.locator('#webhooks-status-filter').selectOption('pending');
    await expect(clear(page)).toBeVisible();
    // A target big enough to hit (WCAG 2.5.8 asks for 24 px).
    const box = await clear(page).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(24);
    expect(box?.width).toBeGreaterThanOrEqual(24);
    await page.locator('#webhooks-status-filter').selectOption('');
    await expect(clear(page)).toHaveCount(0);

    await page.locator('[data-sort-key="forge"]').click();
    await expect(clear(page)).toBeVisible();
  });

  test('resets forge, repo, status, sort and direction, and the saved copies follow', async ({
    page,
    request,
    baseURL,
  }) => {
    await signIn(page, request, baseURL);
    await open(page);
    await page.locator('input[data-filter="forge"][value="forgejo"]').check();
    await page.locator('#webhooks-repo-filter').fill('infra');
    await page.locator('#webhooks-status-filter').selectOption('pending');
    await page.locator('[data-sort-key="hasWebhook"]').click();
    await page.locator('[data-sort-key="hasWebhook"]').click();
    await expect
      .poll(() => serverCopy(page))
      .toMatchObject({
        forge: 'forgejo',
        repo: 'infra',
        status: 'pending',
        sort: 'hasWebhook',
        dir: 'desc',
      });

    await clear(page).click();

    await expect(
      page.locator('input[data-filter="forge"][value=""]'),
    ).toBeChecked();
    await expect(page.locator('#webhooks-repo-filter')).toHaveValue('');
    await expect(page.locator('#webhooks-status-filter')).toHaveValue('');
    await expect(
      page.locator('th:has([data-sort-key="fullName"])'),
    ).toHaveAttribute('aria-sort', 'ascending');
    await expect(clear(page)).toHaveCount(0);
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);

    await expect.poll(() => serverCopy(page)).toMatchObject(DEFAULTS);
    expect(await cookieCopy(page)).toMatchObject(DEFAULTS);

    // It survives a reload, and a second browser (no cookie).
    await page.reload();
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);
    await expect(clear(page)).toHaveCount(0);
    await page.context().clearCookies({ name: 'forge-board-filters' });
    await page.reload();
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);
    await expect(clear(page)).toHaveCount(0);
  });

  test('in the empty state from an unmatched saved search it is there, reachable by keyboard, and clears it', async ({
    page,
    request,
    baseURL,
  }) => {
    await signIn(page, request, baseURL);
    await open(page);
    await page.locator('#webhooks-repo-filter').fill('no-such-repo');
    await expect(page.locator('#webhooks-no-results')).toBeVisible();
    await expect
      .poll(() => serverCopy(page))
      .toMatchObject({
        repo: 'no-such-repo',
      });

    await page.reload();
    await expect(page.locator('#webhooks-no-results')).toBeVisible();
    await expect(page.locator('#webhooks-repo-filter')).toHaveValue(
      'no-such-repo',
    );
    await expect(clear(page)).toBeVisible();

    await page.locator('#webhooks-repo-filter').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(clear(page)).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);
    await expect(page.locator('#webhooks-repo-filter')).toHaveValue('');
    await expect.poll(() => serverCopy(page)).toMatchObject({ repo: '' });
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390]) {
      test(`has no axe violations with the control showing (${scheme}, ${width}px)`, async ({
        page,
        request,
        baseURL,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 800 });
        await signIn(page, request, baseURL);
        await open(page);
        await page.locator('#webhooks-repo-filter').fill('no-such-repo');
        await expect(clear(page)).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});
