import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The board header no longer has a "CI status" pulldown: the quick pills say
// the same thing, and a "No checks" pill covers the one state they lacked.
// The saved state is on the server, so this spec registers its own.
// https://github.com/alrayyes/forge-dashboard/issues/2084

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

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
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
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
  await page.request.put('/api/settings/filter-state', {
    data: { shared, pr: prState, issue: {}, view: {} },
  });
  await expect
    .poll(async () => {
      const got = await (
        await page.request.get('/api/settings/filter-state')
      ).json();
      return JSON.stringify([got?.shared ?? {}, got?.pr ?? {}]);
    })
    .toBe(JSON.stringify([shared, prState]));
}

test.describe('the CI status pulldown is gone (2084)', () => {
  for (const path of ['/pull-requests.html', '/bots.html']) {
    test(`${path} has no CI status pulldown and keeps the CI pills`, async ({
      page,
    }) => {
      await open(page, path);
      await expect(rows(page).first()).toBeVisible();

      await expect(page.locator('select[data-col="status"]')).toHaveCount(0);
      await expect(page.getByLabel('Filter by CI status')).toHaveCount(0);
      await expect(pill(page, 'Passing CI')).toBeVisible();
      await expect(pill(page, 'No checks')).toBeVisible();
    });
  }

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

  test('No checks is not offered when every pull request has checks', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html', [
      pr(1, { ci: 'success' }),
      pr(2, { ci: 'failure' }),
    ]);
    await expect(rows(page)).toHaveCount(2);
    await expect(pill(page, 'Passing CI')).toBeVisible();
    await expect(pill(page, 'No checks')).toBeHidden();
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
  });

  test('a saved No checks status becomes the No checks pill', async ({
    page,
  }) => {
    await seed(page, {}, { status: 'none' });
    await open(page, '/pull-requests.html');

    await expect(rows(page)).toHaveCount(1);
    await expect(pill(page, 'No checks')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('a saved status beside a forge pick is cleared, so the list shows the forge', async ({
    page,
  }) => {
    await seed(page, { forge: 'github' }, { status: 'failure' });
    await open(page, '/pull-requests.html');

    await expect(rows(page)).toHaveCount(3);
    await expect(pill(page, 'GitHub')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#held-picks .held-pick-clear')).toHaveCount(0);
  });

  test('a saved status is written back as a pill, and the old key leaves the saved copy', async ({
    page,
  }) => {
    await seed(page, {}, { status: 'failure' });
    await open(page, '/pull-requests.html');
    await expect(rows(page)).toHaveCount(1);

    await expect
      .poll(async () => {
        const got = await (
          await page.request.get('/api/settings/filter-state')
        ).json();
        return JSON.stringify([got?.pr?.status ?? null, got?.pr?.quick]);
      })
      .toBe(JSON.stringify([null, 'failing']));
  });

  test('a saved pill that no longer exists does not hide the saved status', async ({
    page,
  }) => {
    await seed(page, {}, { status: 'failure', quick: 'bots' });
    await open(page, '/pull-requests.html');
    await expect(rows(page)).toHaveCount(1);
    await expect(pill(page, 'Failing CI')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('a saved status beside a saved pill keeps the pill', async ({
    page,
  }) => {
    await seed(page, {}, { status: 'failure', quick: 'passing' });
    await open(page, '/pull-requests.html');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Pull request 1');
    await expect(pill(page, 'Passing CI')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('an unknown saved status is dropped and nothing is filtered', async ({
    page,
  }) => {
    await seed(page, {}, { status: 'bogus' });
    await open(page, '/pull-requests.html');
    await expect(rows(page)).toHaveCount(3);
    await expect(pill(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Failing CI leaves a pull request whose workflow is held for approval out', async ({
    page,
  }) => {
    await seed(page, {}, { status: 'failure' });
    await open(page, '/pull-requests.html', [
      pr(1, { ci: 'failure', failingCi: true }),
      pr(2, { ci: 'failure', failingCi: false }),
    ]);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Pull request 1');
  });

  test('a draft the server lists is filtered by the migrated pick like any row', async ({
    page,
  }) => {
    await seed(page, {}, { status: 'failure' });
    await open(page, '/pull-requests.html', [
      pr(1, { ci: 'failure', failingCi: true }),
      pr(2, { ci: 'failure', failingCi: true, draft: true }),
      pr(3, { ci: 'success', draft: true }),
    ]);
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).filter({ hasText: 'Pull request 3' })).toHaveCount(
      0,
    );
  });

  test('the Releases page migrates a saved status too, with no dropdown', async ({
    page,
  }) => {
    await seed(page, {}, { status: 'none' });
    await open(page, '/releases.html', [
      pr(40, { kind: 'release', ci: 'none' }),
      pr(41, { kind: 'release', ci: 'success' }),
    ]);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Pull request 40');
    await expect(pill(page, 'No checks')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('select[data-col="status"]')).toHaveCount(0);
  });

  test('Clear filters ends a migrated pick', async ({ page }) => {
    await seed(page, {}, { status: 'success' });
    await open(page, '/pull-requests.html');
    await expect(rows(page)).toHaveCount(1);

    await page.locator('#clear-filters-button').click();
    await expect(rows(page)).toHaveCount(3);
    await expect(pill(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const path of ['/pull-requests.html', '/bots.html']) {
      test(`${path} header has no axe violations in ${scheme} and fits at 390px`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await open(page, path);
        await expect(rows(page).first()).toBeVisible();
        expect(
          (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
            .violations,
        ).toEqual([]);

        await page.setViewportSize({ width: 390, height: 844 });
        expect(
          (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
            .violations,
        ).toEqual([]);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }
  }
});
