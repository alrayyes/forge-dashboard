import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1215: a Conflicts quick filter lists only the pull requests whose
// `mergeStatus` is `conflicting`, so they can be fixed in one pass. The page
// holds no rule of its own: it reads the field the rows already show.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `conflicts-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Conflicts User');
}

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

const MIXED = [
  makePR(1, { title: 'Conflicts with main', mergeStatus: 'conflicting' }),
  makePR(2, { title: 'Merges cleanly', mergeStatus: 'mergeable' }),
  makePR(3, { title: 'Status not known yet', mergeStatus: 'unknown' }),
  makePR(4, {
    title: 'A draft that conflicts',
    draft: true,
    mergeStatus: 'conflicting',
  }),
];

function mockDashboard(page: Page, pullRequests: unknown[]) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
      }),
    }),
  );
}

const pill = (page: Page, name: string) =>
  page.locator('.quick-pills').getByRole('button', { name, exact: true });
const rows = (page: Page) => page.locator('#pr-rows > .row');

test.describe('Conflicts quick filter (#1215)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    // The live stream would push the server's own, newer snapshot over the
    // mock, and the page drops the older one as stale.
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
  });

  test('lists only the conflicting pull requests, a draft that conflicts included', async ({
    page,
  }) => {
    await mockDashboard(page, MIXED);
    await page.reload();
    await expect(rows(page)).toHaveCount(4);

    await pill(page, 'Conflicts').click();

    await expect(pill(page, 'Conflicts')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(pill(page, 'All')).toHaveAttribute('aria-pressed', 'false');
    await expect(
      page.locator('.quick-pills [aria-pressed="true"]'),
    ).toHaveCount(1);
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('#pr-rows')).toContainText('Conflicts with main');
    await expect(page.locator('#pr-rows')).toContainText(
      'A draft that conflicts',
    );
    await expect(page.locator('#pr-rows')).not.toContainText('Merges cleanly');
    await expect(page.locator('#pr-rows')).not.toContainText(
      'Status not known yet',
    );
  });

  test('choosing another pill replaces it, and All clears it', async ({
    page,
  }) => {
    await mockDashboard(page, MIXED);
    await page.reload();
    await pill(page, 'Conflicts').click();
    await pill(page, 'Failing CI').click();
    await expect(pill(page, 'Conflicts')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await pill(page, 'Conflicts').click();
    await pill(page, 'All').click();
    await expect(rows(page)).toHaveCount(4);
  });

  test('it survives a reload like the other quick filters', async ({
    page,
  }) => {
    await mockDashboard(page, MIXED);
    await page.reload();
    await pill(page, 'Conflicts').click();
    // The click saves in the background; a reload before it lands would load
    // the older copy (#900).
    await expect
      .poll(async () => {
        const resp = await page.request.get('/api/settings/filter-state');
        return (await resp.json())?.pr?.quick;
      })
      .toBe('conflicting');

    await page.reload();
    await expect(pill(page, 'Conflicts')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(rows(page)).toHaveCount(2);
  });

  test('with no conflicting pull request the list says nothing matches', async ({
    page,
  }) => {
    await mockDashboard(page, [
      makePR(2),
      makePR(3, { mergeStatus: 'unknown' }),
    ]);
    await page.reload();
    await pill(page, 'Conflicts').click();

    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator('#pr-no-results')).toBeVisible();
  });

  test('has no axe-core violations with the pill active', async ({ page }) => {
    await mockDashboard(page, MIXED);
    await page.reload();
    await pill(page, 'Conflicts').click();
    await expect(rows(page)).toHaveCount(2);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
