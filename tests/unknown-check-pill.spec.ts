import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { type CheckRow, serveChecks } from './checks-feed-helper';
import { test } from './server-fixture';

// A check whose conclusion the page was not written for is shown as unknown,
// not as a failure or a wait, and a branch's pill counts every job its dialog
// lists (#4055).

const JOBS = [
  { name: 'lint', status: 'completed', conclusion: 'success', jobId: 1 },
  { name: 'build', status: 'completed', conclusion: 'cancelled', jobId: 2 },
  { name: 'scan', status: 'completed', conclusion: 'brand_new', jobId: 3 },
  { name: 'deploy', status: 'waiting', jobId: 4 },
  {
    name: 'verify',
    status: 'unknown',
    reportedStatus: 'brand_new_status',
    jobId: 5,
  },
].map((job) => ({ ...job, url: '' }));

const ROW = {
  forge: 'github',
  fullName: 'example/service',
  url: 'https://example.com/example/service',
  branch: 'main',
  status: 'unknown',
  commit: {
    sha: '42381c9',
    subject: 'Update a dependency',
    author: 'someone',
    committedAt: new Date(Date.now() - 1800_000).toISOString(),
  },
  failingJobs: [],
  finishedAt: null,
  durationSeconds: null,
  runUrl: 'https://example.com/example/service/actions/runs/1',
  checks: {
    passed: 1,
    skipped: 0,
    running: 0,
    waiting: 0,
    failed: 0,
    unknown: 2,
    cancelled: 1,
    held: 1,
  },
  staleSince: null,
};

async function open(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 0,
          passed: 0,
          running: 0,
          unknown: 1,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: 1,
        },
        branches: [ROW],
      }),
    }),
  );
  await serveChecks(page, () => JOBS as CheckRow[]);
  await page.goto('/');
  const pill = page.getByRole('button', { name: /open pipeline/i }).first();
  await expect(pill).toBeVisible();

  return pill;
}

for (const [name, size] of [
  ['phone', { width: 390, height: 800 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test.describe(`an unknown check on a ${name}`, () => {
    test.use({ viewport: size });

    test('the pill counts every job and the dialog calls it unknown', async ({
      page,
    }) => {
      const pill = await open(page);
      const label = (await pill.getAttribute('aria-label')) ?? '';
      expect(label).toContain('2 unknown');
      expect(label).toContain('1 cancelled');
      expect(label).toContain('1 held');

      await pill.click();
      const items = page
        .getByRole('dialog', { name: /pipeline/i })
        .getByRole('listitem');
      await expect(items).toHaveCount(JOBS.length);
      await expect(items.filter({ hasText: 'Unknown' })).toHaveCount(2);
      await expect(items.filter({ hasText: 'Failed' })).toHaveCount(0);
    });

    test('the row reads Unknown, not Running (#4063)', async ({ page }) => {
      const pill = await open(page);
      await expect(pill).toContainText('Unknown');
      await expect(pill).not.toContainText('Running');
    });

    test('the dialog names the word the forge sent, in text and tooltip', async ({
      page,
    }) => {
      const pill = await open(page);
      await pill.click();
      const dialog = page.getByRole('dialog', { name: /pipeline/i });
      const status = dialog.getByRole('listitem').filter({ hasText: 'verify' });
      await expect(status).toContainText('Unknown');
      await expect(status.getByTestId('check-forge-word')).toHaveText(
        'brand_new_status',
      );
      await expect(status.locator('.pipeline-check-status')).toHaveAttribute(
        'title',
        /brand_new_status/,
      );
      const scan = dialog.getByRole('listitem').filter({ hasText: 'scan' });
      await expect(scan.getByTestId('check-forge-word')).toHaveText(
        'brand_new',
      );
      const fits = await dialog.evaluate(
        (el) => el.scrollWidth <= el.clientWidth,
      );
      expect(fits).toBe(true);
    });

    test('has no axe violations, light and dark', async ({ page }) => {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await (await open(page)).click();
        await expect(
          page.getByTestId('check-forge-word').first(),
        ).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      }
    });
  });
}

// A pull request whose only odd check is unknown reads pending, so the quick
// filters file it under Running (#4055).
test('a pull request row draws its unknown check', async ({ page }) => {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [
          {
            forge: 'github',
            repo: 'example/service',
            number: 7,
            title: 'Odd check',
            url: 'https://github.com/example/service/pull/7',
            author: 'someone',
            draft: false,
            ci: 'pending',
            checks: {
              passed: 3,
              skipped: 0,
              running: 0,
              waiting: 0,
              failed: 0,
              unknown: 1,
            },
            labels: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            mergeStatus: 'mergeable',
          },
        ],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  const pill = page.locator('#pr-rows > .row .ci-pill').first();
  await expect(pill.locator('.ci-seg-unknown')).toHaveText('1');
  await expect(pill).toHaveAttribute(
    'aria-label',
    /3 passed, 1 unknown\. Open pipeline$/,
  );
});
