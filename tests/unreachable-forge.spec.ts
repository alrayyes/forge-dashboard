import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1199: a forge that can't be reached is treated like a spent rate limit
// (#755): its mutating controls aren't drawn, one banner says so with a
// single Retry, and the rows' own reasons are left alone.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `unreachable-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Unreachable User');
}

function makePR(number: number, overrides: Record<string, unknown> = {}) {
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
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: true,
    kind: 'regular',
    ...overrides,
  };
}

const down = (extra: Record<string, unknown> = {}) => ({
  forge: 'github',
  reachable: false,
  repoCount: 1,
  errorKind: 'unreachable',
  error: 'dial tcp 140.82.121.6:443: i/o timeout',
  staleSince: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...extra,
});
const up = (forge = 'github') => ({ forge, reachable: true, repoCount: 1 });

function mockDashboard(
  page: Page,
  forges: unknown[],
  pullRequests: unknown[],
  state: { current?: { forges: unknown[] } } = {},
) {
  const body = () =>
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: state.current?.forges ?? forges,
      pullRequests,
      issues: [],
    });
  // The snapshot, and the forced refresh (a different path) the banner's Retry
  // sends.
  return page.route(
    /\/api\/dashboard(\/refresh|\/stream)?(\?.*)?$/,
    (route: Route) => {
      // The stream isn't part of this journey.
      if (route.request().url().includes('/stream')) return route.abort();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: body(),
      });
    },
  );
}

const MUTATING = [
  'Merge',
  'Update branch',
  'Close',
  'Enable auto-merge',
  'Dependabot: Rebase',
  'Renovate: Rebase',
];

test.describe('an unreachable forge goes read-only (#1199)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('its rows draw no mutating control, no per-row Retry and no pointer to a status line', async ({
    page,
  }) => {
    await mockDashboard(page, [down()], [makePR(1), makePR(2)]);
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByText(/Pull request/)).toBeVisible();
    for (const name of MUTATING)
      await expect(row.getByRole('button', { name, exact: true })).toHaveCount(
        0,
      );
    await expect(row.getByRole('button', { name: 'More actions' })).toHaveCount(
      0,
    );
    await expect(page.locator('#pr-rows')).not.toContainText(
      'See the forge status above',
    );
    await expect(
      page.locator('#pr-rows').getByRole('button', { name: /Retry/ }),
    ).toHaveCount(0);
    await expect(
      row.getByRole('button', { name: /Open pipeline/ }),
    ).toBeEnabled();
  });

  test('one banner says so, with the cause and the age of the data, and one Retry', async ({
    page,
  }) => {
    await mockDashboard(page, [down()], [makePR(1), makePR(2)]);
    await page.reload();

    const banner = page.locator('#unreachable-banner');
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(banner).toContainText(
      /GitHub is unreachable\. Showing the last data from \d{1,2}:\d{2}/,
    );
    await expect(banner).toContainText('isn’t answering');
    await expect(banner.getByRole('button', { name: 'Retry' })).toHaveCount(1);
  });

  test('Retry forces a refresh, and when the forge answers the controls return with a toast and the banner clears', async ({
    page,
  }) => {
    const state: { current?: { forges: unknown[] } } = {};
    await mockDashboard(page, [down()], [makePR(1)], state);
    await page.reload();
    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveCount(0);

    state.current = { forges: [up()] };
    const refresh = page.waitForRequest(
      (r) =>
        r.url().includes('/api/dashboard/refresh') && r.method() === 'POST',
    );
    await page
      .locator('#unreachable-banner')
      .getByRole('button', { name: 'Retry' })
      .click();
    await refresh;

    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toBeVisible();
    await expect(page.locator('#unreachable-banner')).toHaveCount(0);
    await expect(
      page.locator('#feedback-toasts .feedback-toast'),
    ).toContainText('GitHub is reachable again');
  });

  test('a forge going down while the list is open loses its controls without a reload', async ({
    page,
  }) => {
    const state: { current?: { forges: unknown[] } } = {};
    await mockDashboard(page, [up()], [makePR(1)], state);
    await page.reload();
    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toBeVisible();

    state.current = { forges: [down()] };
    await page.locator('#force-refresh-button').click();

    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('#unreachable-banner')).toBeVisible();
  });

  test('another forge is unaffected, and a reachable forge keeps the row’s own reason', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [down(), up('forgejo')],
      [
        makePR(1, { title: 'On GitHub' }),
        makePR(2, {
          forge: 'forgejo',
          repo: 'alrayyes/other',
          title: 'On Forgejo',
          url: 'https://example.com/forgejo/2',
          ci: 'pending',
          mergeStatus: 'blocked',
          behind: false,
        }),
      ],
    );
    await page.reload();

    const gh = page.locator('#pr-rows .row', { hasText: 'On GitHub' });
    const fj = page.locator('#pr-rows .row', { hasText: 'On Forgejo' });
    await expect(
      gh.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveCount(0);
    await expect(
      fj.getByRole('button', { name: 'Merge', exact: true }),
    ).toBeVisible();
    await expect(fj).toContainText('Waiting for CI to finish');
    await expect(page.locator('#unreachable-banner')).not.toContainText(
      'Forgejo',
    );
  });

  test('a forge with no cause text still reads plainly', async ({ page }) => {
    await mockDashboard(
      page,
      [down({ errorKind: 'unauthorized', error: 'bad credentials' })],
      [makePR(1)],
    );
    await page.reload();
    await expect(page.locator('#unreachable-banner')).toContainText(
      'Check the token in Settings',
    );
    await expect(page.locator('#unreachable-banner')).not.toContainText(
      'bad credentials',
    );
  });

  test('has no axe-core violations and no horizontal scroll at desktop and 375px, and the banner stays in view while scrolling', async ({
    page,
  }) => {
    const many = Array.from({ length: 30 }, (_, i) => makePR(i + 1));
    await mockDashboard(page, [down()], many);
    await page.reload();
    const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
    expect(
      (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
    ).toEqual([]);

    await page.setViewportSize({ width: 375, height: 700 });
    expect(
      (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
    ).toEqual([]);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.evaluate(() => window.scrollTo(0, 900));
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(600);
    const box = await page.locator('#unreachable-banner').boundingBox();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect(box?.y ?? 999).toBeLessThan(40);
  });
});
