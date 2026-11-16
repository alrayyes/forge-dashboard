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
].map((job) => ({ ...job, url: '' }));

const ROW = {
  forge: 'github',
  fullName: 'example/service',
  url: 'https://example.com/example/service',
  branch: 'main',
  status: 'running',
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
    unknown: 1,
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
          running: 1,
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
      expect(label).toContain('1 unknown');
      expect(label).toContain('1 cancelled');
      expect(label).toContain('1 held');

      await pill.click();
      const items = page
        .getByRole('dialog', { name: /pipeline/i })
        .getByRole('listitem');
      await expect(items).toHaveCount(JOBS.length);
      await expect(items.filter({ hasText: 'Unknown' })).toHaveCount(1);
      await expect(items.filter({ hasText: 'Failed' })).toHaveCount(0);
    });

    test('has no axe violations, light and dark', async ({ page }) => {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await open(page);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      }
    });
  });
}
