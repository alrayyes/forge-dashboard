import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #724: the Activity list outlives a reload, for the life of the tab. A
// request still queued comes back from the server's own updateRequest (#982),
// so only finished entries are stored here.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `activity-persist-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Activity User');
}

function makePR(number: number) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
  };
}

// Serves two behind pull requests. Update branch succeeds on #1 (the server
// then carries its queued request, as it does in production) and is refused
// on #2.
async function setup(page: Page) {
  const prs = [makePR(1), makePR(2)];
  const recorded = new Set<number>();
  const served = () =>
    prs.map((pr) =>
      recorded.has(pr.number)
        ? {
            ...pr,
            updateRequest: {
              phase: 'queued',
              requestedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            },
          }
        : pr,
    );
  const body = () =>
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
      pullRequests: served(),
      issues: [],
    });
  for (const pattern of ['**/api/dashboard*', '**/api/dashboard/refresh'])
    await page.route(pattern, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: body(),
      }),
    );
  await page.route('**/api/pull-requests/update-branch', (route: Route) => {
    const { number } = route.request().postDataJSON() as { number: number };
    if (number === 2)
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'x', message: 'upstream broke' }),
      });
    recorded.add(number);
    return route.fulfill({ status: 202 });
  });
  await page.reload();
}

const rowFor = (page: Page, n: number): Locator =>
  page.locator('#pr-rows .row', { hasText: `Pull request ${n}` });

async function updateBranch(page: Page, n: number) {
  await rowFor(page, n).getByRole('button', { name: 'Update branch' }).click();
}

async function openActivity(page: Page) {
  await page.locator('#activity-toggle').click();
  return page.locator('#activity-panel .activity-item');
}

test.describe('the Activity list across a reload', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('finished and queued entries are still listed after a reload, until Clear finished', async ({
    page,
  }) => {
    await setup(page);
    await updateBranch(page, 1);
    await updateBranch(page, 2);
    await expect(rowFor(page, 2).locator('.row-feedback')).toContainText(
      'Failed',
    );

    await page.reload();

    const items = await openActivity(page);
    await expect(items).toHaveCount(2);
    await expect(items.filter({ hasText: '#2' })).toContainText('Failed');
    await expect(items.filter({ hasText: '#2' })).toContainText(
      'upstream broke',
    );
    await expect(items.filter({ hasText: '#1' })).toContainText('Queued');
    // A restored failure can't be retried: the call it would repeat is gone.
    await expect(
      items.filter({ hasText: '#2' }).getByRole('button', { name: 'Retry' }),
    ).toHaveCount(0);

    await page
      .locator('#activity-panel')
      .getByRole('button', { name: 'Clear finished' })
      .click();
    await page.reload();

    const after = await openActivity(page);
    await expect(after).toHaveCount(1);
    await expect(after.first()).toContainText('#1');
  });

  test('with storage blocked the page works as before, with an empty list', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const refuse = () => {
        throw new DOMException('blocked', 'SecurityError');
      };
      Object.defineProperty(window, 'sessionStorage', {
        get: refuse,
      });
    });
    await setup(page);
    await updateBranch(page, 2);
    await expect(rowFor(page, 2).locator('.row-feedback')).toContainText(
      'Failed',
    );

    await page.reload();

    await expect(page.locator('#activity-toggle')).toContainText('Activity 0');
    await expect(rowFor(page, 1)).toBeVisible();
  });
});
