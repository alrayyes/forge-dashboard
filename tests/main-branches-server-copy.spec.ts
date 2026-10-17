import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1620: the Branches filter (status, forge, search) follows the account like
// the other pages' filters: the cookie paints the first frame, the server copy
// restores it in a browser that has no cookie. The saved state is per user, so
// each test registers its own.
// https://github.com/alrayyes/forge-dashboard/issues/1620

const row = (
  fullName: string,
  status: 'failed' | 'passed',
  forge = 'github',
) => ({
  forge,
  fullName,
  url: `https://example.com/${fullName}`,
  branch: 'main',
  status,
  commit: {
    sha: 'd98f3c2',
    subject: `fix: change in ${fullName}`,
    author: 'sre-dev',
    committedAt: new Date().toISOString(),
  },
  failingJobs: status === 'failed' ? ['lint'] : [],
  finishedAt: new Date().toISOString(),
  durationSeconds: 60,
  runUrl: `https://example.com/${fullName}/actions/runs/1`,
  stale: false,
  staleSince: null,
});

const BRANCHES = [
  row('acme/ingress', 'failed'),
  row('infra/homelab', 'failed', 'forgejo'),
  row('acme/auth', 'passed'),
  row('acme/billing', 'passed'),
];

async function mock(page: Page) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: { failed: 2, passed: 2, running: 0, none: 0, total: 4 },
        branches: BRANCHES,
      }),
    }),
  );
}

const rows = (page: Page) => page.locator('[data-testid="main-branch-row"]');
const status = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Filter by status' }).getByRole('button', {
    name: new RegExp(`^${name}`),
  });
const serverCopy = async (page: Page) =>
  JSON.stringify(
    await (await page.request.get('/api/settings/filter-state')).json(),
  );

async function signUp(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  await registerViaInvite(
    page,
    request,
    baseURL,
    `mb-server-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    'Branches Server Copy',
  );
  await mock(page);
}

test.describe('the Branches filter follows the account (#1620)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await signUp(page, request, baseURL);
    await page.goto('/');
    await expect(rows(page)).toHaveCount(4);
  });

  test('status, forge and search come back with no cookie', async ({
    page,
    context,
  }) => {
    await status(page, 'Failing').click();
    await page
      .getByRole('group', { name: 'Filter by forge' })
      .getByRole('button', { name: /Forgejo/ })
      .click();
    await page.getByRole('searchbox').fill('Homelab');
    await expect(rows(page)).toHaveCount(1);
    await expect
      .poll(() => serverCopy(page), { timeout: 5000 })
      .toContain('Homelab');

    await context.clearCookies({ name: 'forge-board-filters' });
    await page.reload();

    await expect(page.getByRole('searchbox')).toHaveValue('Homelab');
    await expect(rows(page)).toHaveCount(1);
    await expect(
      page
        .getByRole('group', { name: 'Filter by forge' })
        .getByRole('button', { name: /Forgejo/ }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('a second browser restores it from the server copy', async ({
    page,
    browser,
    baseURL,
  }) => {
    await status(page, 'Failing').click();
    await expect(rows(page)).toHaveCount(2);
    await expect
      .poll(() => serverCopy(page), { timeout: 5000 })
      .toContain('failed');

    const other = await browser.newContext({
      baseURL,
      storageState: await page.context().storageState(),
    });
    await other.clearCookies({ name: 'forge-board-filters' });
    const second = await other.newPage();
    await mock(second);
    await second.goto('/');
    await expect(rows(second)).toHaveCount(2);
    await expect(status(second, 'Failing')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await other.close();
  });

  test('a search typed just before leaving reaches the server copy', async ({
    page,
  }) => {
    await page.getByRole('searchbox').fill('zqxjk');
    await page.goto('/pull-requests.html');
    await expect
      .poll(() => serverCopy(page), { timeout: 5000 })
      .toContain('zqxjk');
  });

  test('Reset filters clears the server copy too', async ({
    page,
    context,
  }) => {
    await page.getByRole('searchbox').fill('nomatch');
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await expect(rows(page)).toHaveCount(4);
    await expect
      .poll(() => serverCopy(page), { timeout: 5000 })
      .not.toContain('nomatch');
    await context.clearCookies({ name: 'forge-board-filters' });
    await page.reload();
    await expect(rows(page)).toHaveCount(4);
  });

  test('a saved status survives a trip to another page and back', async ({
    page,
  }) => {
    await status(page, 'Passing').click();
    await page.goto('/pull-requests.html');
    await page.goto('/');
    await expect(rows(page)).toHaveCount(2);
  });

  test('a tab left open does not erase a title another tab saved', async ({
    page,
    context,
  }) => {
    const other = await context.newPage();
    await other.goto('/pull-requests.html');
    await other.locator('input[data-col="title"]').fill('newer');
    await expect
      .poll(() => serverCopy(page), { timeout: 5000 })
      .toContain('newer');

    await status(page, 'Failing').click();
    await expect
      .poll(() => serverCopy(page), { timeout: 5000 })
      .toContain('failed');
    expect(await serverCopy(page)).toContain('newer');
  });
});
