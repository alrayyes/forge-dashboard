import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { factsOf } from './check-facts';
import { serveChecks } from './checks-feed-helper';
import { test } from './server-fixture';

// A GitHub pull request whose only non-passing check is a cancelled run says
// Cancelled, not Failed, and agrees with its pipeline dialog. The server
// decides the state (internal/github tests); the page draws it, in words.
// https://github.com/alrayyes/forge-dashboard/issues/3301

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function pr(
  number: number,
  title: string,
  ci: string,
  checks: object,
  forge = 'github',
) {
  return {
    forge,
    repo: 'alrayyes/forgejo-mirror-sync',
    number,
    title,
    url: `https://example.test/alrayyes/forgejo-mirror-sync/pull/${number}`,
    author: 'claude',
    draft: false,
    ci,
    checks: { passed: 0, running: 0, waiting: 0, failed: 0, ...checks },
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'blocked',
    kind: 'regular',
  };
}

const CANCELLED = pr(62, 'Only cancelled', 'cancelled', {
  passed: 18,
  skipped: 3,
  cancelled: 1,
});
// scaffold-php-api#204 (#3378): a Forgejo run cancelled after four jobs passed.
const FORGEJO_CANCELLED = pr(
  64,
  'Forgejo cancelled run',
  'cancelled',
  { passed: 4, cancelled: 9 },
  'forgejo',
);
const FAILED = pr(63, 'Really failed', 'failure', { passed: 18, failed: 1 });

const JOBS = [
  ...Array.from({ length: 4 }, (_, i) => ({
    name: `job-${i}`,
    ...factsOf('success'),
    jobId: 100 + i,
    url: '',
  })),
  { name: 'check', ...factsOf('cancelled'), jobId: 200, url: '' },
];

async function open(page: Page) {
  await serveChecks(page, () => JOBS);
  await page.route('**/api/v1/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [CANCELLED, FAILED, FORGEJO_CANCELLED],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
}

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title });

test.describe('a cancelled-only pull request (3301)', () => {
  test('says Cancelled in words, and Failed only for the real failure', async ({
    page,
  }) => {
    await open(page);

    const pill = row(page, 'Only cancelled').locator('.ci-pill');
    await expect(pill).toContainText('Cancelled');
    await expect(pill).not.toContainText('Failed');
    await expect(row(page, 'Really failed').locator('.ci-pill')).toContainText(
      'Failed',
    );
  });

  test('a Forgejo run cancelled after some jobs passed says Cancelled, not Passed', async ({
    page,
  }) => {
    await open(page);

    const pill = row(page, 'Forgejo cancelled run').locator('.ci-pill');
    await expect(pill).toContainText('Cancelled');
    await expect(pill).not.toContainText('Passed');
  });

  test('the dialog lists the same cancelled check', async ({ page }) => {
    await open(page);

    await row(page, 'Only cancelled')
      .getByRole('button', { name: /open pipeline/i })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog.locator('.pipeline-check')).toHaveCount(JOBS.length);
    await expect(
      dialog.locator('.pipeline-check', { hasText: 'Cancelled' }),
    ).toHaveCount(1);
    await expect(dialog.getByText('Failed')).toHaveCount(0);
  });

  test('the Failing CI filter leaves it out', async ({ page }) => {
    await open(page);

    await page
      .getByRole('group', { name: 'Quick filters' })
      .getByRole('button', { name: 'Failing CI', exact: true })
      .click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    await expect(row(page, 'Really failed')).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [390, 820, 1280]) {
      test(`has no axe violations at ${width}px, ${scheme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await open(page);
        const results = await new AxeBuilder({ page })
          .withTags(AXE_TAGS)
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});
