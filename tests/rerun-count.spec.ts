import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { serveChecks } from './checks-feed-helper';
import { test } from './server-fixture';

const failed = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  status: 'completed',
  conclusion: 'failure',
  url: '',
  ...extra,
});

const pr = (over: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 42,
  title: 'Add structured logging',
  url: 'https://example.com/42',
  author: 'ryankes',
  draft: false,
  ci: 'failure',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'mergeable',
  behind: false,
  ...over,
});

async function open(
  page: Page,
  checks: unknown[],
  opts: { forge?: string; health?: Record<string, unknown> } = {},
) {
  const forge = opts.forge ?? 'github';
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge, reachable: true, repoCount: 1, ...opts.health }],
        pullRequests: [pr({ forge })],
        issues: [],
      }),
    }),
  );
  await serveChecks(page, () => checks);
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: 'Open pipeline' })
    .click();
  return page.getByRole('dialog', { name: 'Pipeline checks' });
}

test.describe('rerun failed checks says how many it reruns', () => {
  test('the button and the line carry the count of failed checks with a run', async ({
    page,
  }) => {
    const dialog = await open(page, [
      failed('build', { runId: 1 }),
      failed('lint', { runId: 1 }),
      {
        name: 'unit',
        status: 'completed',
        conclusion: 'success',
        url: '',
        runId: 1,
      },
    ]);
    const button = dialog.getByRole('button', {
      name: /^Rerun failed checks \(2\)/,
    });
    await expect(button).toHaveText('Rerun failed checks (2)');
    const line = dialog.locator('.pipeline-rerun-count');
    await expect(line).toHaveText('2 failed checks will rerun on GitHub.');
    await expect(line).not.toContainText(/pass/i);
  });

  test('one failed check reads in the singular, and a timed-out one counts', async ({
    page,
  }) => {
    const dialog = await open(page, [
      failed('build', { runId: 1, conclusion: 'timed_out' }),
    ]);
    await expect(dialog.locator('.pipeline-rerun-count')).toHaveText(
      '1 failed check will rerun on GitHub.',
    );
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks (1)' }),
    ).toBeVisible();
  });

  test('a failed check with no run is named as left out and not counted', async ({
    page,
  }) => {
    const dialog = await open(page, [
      failed('build', { runId: 1 }),
      failed('ci/circleci', { jobId: 5 }),
    ]);
    await expect(dialog.locator('.pipeline-rerun-count')).toHaveText(
      "1 failed check will rerun on GitHub. 1 can't be rerun from here.",
    );
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks (1)' }),
    ).toBeVisible();
  });

  test('with nothing to rerun there is no button, only the line', async ({
    page,
  }) => {
    const dialog = await open(page, [
      failed('ci/circleci'),
      failed('ci/other'),
    ]);
    await expect(dialog.locator('.pipeline-rerun-count')).toHaveText(
      'None of the 2 failed checks can be rerun from here.',
    );
    await expect(
      dialog.getByRole('button', { name: /Rerun failed checks/ }),
    ).toHaveCount(0);
  });

  test('a single failed check with no run reads in the singular', async ({
    page,
  }) => {
    const dialog = await open(page, [failed('ci/circleci')]);
    await expect(dialog.locator('.pipeline-rerun-count')).toHaveText(
      "The failed check can't be rerun from here.",
    );
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const width of [320, 820]) {
      test(`a long list of failures with no run scrolls by keyboard at ${width}px in ${theme} with no axe violation`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 600 });
        const long = 'x'.repeat(40);
        const checks = Array.from({ length: 30 }, (_, i) =>
          failed(`ci/external-${i} ${long}`),
        );
        const dialog = await open(page, checks);
        await expect(dialog.locator('.pipeline-rerun-count')).toBeVisible();
        const body = dialog.locator('.pipeline-dialog-body');
        expect(
          await body.evaluate((b) => b.scrollHeight > b.clientHeight),
        ).toBe(true);
        await expect(body).toHaveAttribute('tabindex', '0');
        await expect(body).toHaveAccessibleName('Pipeline checks');
        await body.focus();
        await expect(body).toBeFocused();
        await page.keyboard.press('End');
        await expect
          .poll(() => body.evaluate((b) => b.scrollTop))
          .toBeGreaterThan(0);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }

  test('a Forgejo with no rerun route draws no count, only its reason', async ({
    page,
  }) => {
    const reason = 'Rerunning checks needs Forgejo 17 or later.';
    const dialog = await open(page, [failed('build', { runId: 1 })], {
      forge: 'forgejo',
      health: { rerunChecksBlocked: reason },
    });
    await expect(dialog.getByRole('status').first()).toContainText(reason);
    await expect(dialog.locator('.pipeline-rerun-count')).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: /Rerun failed checks/ }),
    ).toHaveCount(0);
  });

  test('a queued rerun reads "Rerun queued" with the status text unchanged', async ({
    page,
  }) => {
    await page.route('**/api/v1/pull-requests/rerun-checks', (route) =>
      route.fulfill({ status: 204 }),
    );
    const dialog = await open(page, [failed('build', { runId: 1 })]);
    await dialog
      .getByRole('button', { name: 'Rerun failed checks (1)' })
      .click();
    await expect(
      dialog.getByRole('button', { name: 'Rerun queued' }),
    ).toBeVisible();
    await expect(dialog.getByRole('status')).toHaveText(
      'Rerun queued. The new results show here after the next refresh.',
    );
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const width of [320, 390, 820, 1280]) {
      test(`the line and button fit at ${width}px in ${theme} with no axe violation`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 900 });
        const dialog = await open(page, [
          failed('build', { runId: 1 }),
          failed('ci/circleci'),
        ]);
        const button = dialog.getByRole('button', {
          name: 'Rerun failed checks (1)',
        });
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        if (width <= 760) expect(box?.height).toBeGreaterThanOrEqual(44);
        const pageOverflows = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        expect(pageOverflows).toBe(false);
        const dialogFits = await dialog.evaluate(
          (d) => d.scrollWidth <= d.clientWidth,
        );
        expect(dialogFits).toBe(true);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});
