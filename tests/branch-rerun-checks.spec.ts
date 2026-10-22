import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// The Main branches pipeline dialog offers "Rerun failed checks" on a failed
// branch, as the pull request dialog does.

function branch(status: 'failed' | 'passed') {
  const failed = status === 'failed';
  return {
    forge: 'github',
    fullName: 'acme/auth-service',
    url: 'https://example.com/acme/auth-service',
    branch: 'main',
    status,
    commit: {
      sha: 'd98f3c2',
      subject: 'fix: change',
      author: 'sre-dev',
      committedAt: new Date(Date.now() - 1800_000).toISOString(),
    },
    failingJobs: failed ? ['test'] : [],
    finishedAt: null,
    durationSeconds: null,
    runUrl: 'https://example.com/acme/auth-service/actions/runs/1',
    checks: { passed: 1, running: 0, waiting: 0, failed: failed ? 1 : 0 },
    stale: false,
    staleSince: null,
  };
}

async function openPanel(page: Page, status: 'failed' | 'passed') {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/main-branches', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: status === 'failed' ? 1 : 0,
          passed: status === 'passed' ? 1 : 0,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: 1,
        },
        branches: [branch(status)],
      }),
    }),
  );
  await page.route('**/api/main-branches/checks*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        checks: [
          {
            name: 'test',
            state: status === 'failed' ? 'failure' : 'success',
            url: 'https://example.com/r/2',
          },
        ],
      }),
    }),
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: /open pipeline/i })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: /pipeline/i });
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  return dialog;
}

test.describe('main branches rerun failed checks', () => {
  test('a failed branch offers the button, which posts for that repository and holds a queued state', async ({
    page,
  }) => {
    let posted: unknown = null;
    await page.route('**/api/main-branches/rerun-checks', async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({ status: 204 });
    });
    const dialog = await openPanel(page, 'failed');

    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();

    await expect(dialog.getByRole('status')).toContainText('Rerun queued');
    expect(posted).toEqual({ forge: 'github', fullName: 'acme/auth-service' });
    await expect(
      dialog.getByRole('button', { name: 'Rerun queued' }),
    ).toBeDisabled();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a refused rerun shows the forge reason and leaves the button for another try', async ({
    page,
  }) => {
    await page.route('**/api/main-branches/rerun-checks', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'not_mergeable',
          message: 'no failed job to rerun on this branch',
          error: 'no failed job to rerun on this branch',
        }),
      }),
    );
    const dialog = await openPanel(page, 'failed');

    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();

    await expect(dialog.getByRole('alert')).toContainText(
      'no failed job to rerun on this branch',
    );
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeEnabled();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a passing branch has no button', async ({ page }) => {
    const dialog = await openPanel(page, 'passed');

    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);
  });
});
