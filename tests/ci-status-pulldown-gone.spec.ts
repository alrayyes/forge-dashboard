import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The board header no longer has a "CI status" pulldown: the quick pills say
// the same thing, and a "No checks" pill covers the one state they lacked.
// The saved state is on the server, so this spec registers its own.
// https://github.com/alrayyes/forge-dashboard/issues/2084

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    kind: 'regular',
    ...overrides,
  };
}

const bump = (number: number, overrides: Record<string, unknown> = {}) =>
  pr(number, {
    title: `Bump package-${number} from 1.0.0 to 1.0.1`,
    author: 'dependabot',
    kind: 'dependency',
    ...overrides,
  });

const MIXED = [
  pr(1, { ci: 'success' }),
  pr(2, { ci: 'failure' }),
  pr(3, { ci: 'none' }),
  bump(20, { ci: 'success' }),
  bump(21, { ci: 'none' }),
];

async function open(page: Page, url: string, pullRequests = MIXED) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(url);
}

const rows = (page: Page) => page.locator('#pr-rows > .row');
const pill = (page: Page, name: string) =>
  page
    .getByRole('group', { name: 'Quick filters' })
    .getByRole('button', { name, exact: true });

// Seeds the saved copy and waits until the server reports it, so the page
// opened next reads the seed and not an older write.
async function seed(
  page: Page,
  shared: Record<string, string>,
  prState: Record<string, string>,
) {
  await page.request.put('/api/v1/settings/filter-state', {
    data: { shared, pr: prState, issue: {}, view: {} },
  });
  await expect
    .poll(async () => {
      const got = await (
        await page.request.get('/api/v1/settings/filter-state')
      ).json();
      return JSON.stringify([got?.shared ?? {}, got?.pr ?? {}]);
    })
    .toBe(JSON.stringify([shared, prState]));
}

test.describe('the CI status pulldown is gone (2084)', () => {
  test('the Failing CI pill is offered when something fails', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html');
    await expect(rows(page)).toHaveCount(3);
    await expect(pill(page, 'Failing CI')).toBeVisible();
  });

  test('No checks is offered only when a pull request has no checks, and lists those', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html');
    await expect(rows(page)).toHaveCount(3);
    await pill(page, 'No checks').click();
    await expect(pill(page, 'No checks')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Pull request 3');

    await pill(page, 'All').click();
    await expect(rows(page)).toHaveCount(3);
  });

  test('a saved CI status becomes the matching pill, not an invisible filter', async ({
    page,
  }) => {
    await seed(page, {}, { status: 'failure' });
    await open(page, '/pull-requests.html');

    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Pull request 2');
    await expect(pill(page, 'Failing CI')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('#held-picks .held-pick-clear')).toHaveCount(0);

    // The page saves the migrated state once, so the old key leaves the copy.
    await expect
      .poll(async () => {
        const got = await (
          await page.request.get('/api/v1/settings/filter-state')
        ).json();
        return JSON.stringify([got?.pr?.status ?? null, got?.pr?.quick]);
      })
      .toBe(JSON.stringify([null, 'failing']));
  });
});
