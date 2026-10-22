import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

const pr = {
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
};

const runUrl = 'https://github.com/alrayyes/forge-dashboard/runs/9';

async function setup(
  page: Page,
  log: { status: number; body: unknown },
): Promise<string[]> {
  const asked: string[] = [];
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pr],
        issues: [],
      }),
    }),
  );
  await page.route('**/api/pull-requests/checks*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        checks: [
          { name: 'build', state: 'failure', url: runUrl, jobId: 9 },
          { name: 'lint', state: 'success', url: `${runUrl}0` },
        ],
      }),
    }),
  );
  await page.route('**/api/checks/log*', (route: Route) => {
    asked.push(route.request().url());
    return route.fulfill({
      status: log.status,
      contentType: 'application/json',
      body: JSON.stringify(log.body),
    });
  });
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: 'Open pipeline' })
    .click();

  return asked;
}

test.describe('a check run output in the pipeline dialog', () => {
  test('View run shows the output with a Copy button, and copies it', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const asked = await setup(page, {
      status: 200,
      body: { text: 'step 1\nboom: exit 1\n', truncated: false },
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    const toggle = dialog.getByRole('button', { name: 'View run: build' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();

    await expect(
      dialog.getByRole('button', { name: 'Hide run: build' }),
    ).toHaveAttribute('aria-expanded', 'true');
    const output = dialog.getByRole('region', { name: 'Output: build' });
    await expect(output).toContainText('boom: exit 1');
    expect(new URL(asked[0]).searchParams.get('jobId')).toBe('9');
    expect(new URL(asked[0]).searchParams.get('forge')).toBe('github');

    await dialog.getByRole('button', { name: 'Copy output: build' }).click();
    await expect(dialog.locator('.run-output-status')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'step 1\nboom: exit 1\n',
    );

    // The run on the forge stays one click away.
    await expect(
      dialog.getByRole('link', { name: /Open on GitHub .*: build/ }),
    ).toHaveAttribute('href', runUrl);

    const results = await new AxeBuilder({ page })
      .include('#pipeline-dialog')
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('the output is reachable from the keyboard and hides again', async ({
    page,
  }) => {
    await setup(page, {
      status: 200,
      body: { text: 'line\n', truncated: false },
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const toggle = dialog.getByRole('button', { name: 'View run: build' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    const output = dialog.getByRole('region', { name: 'Output: build' });
    await expect(output).toBeVisible();
    await output.focus();
    await expect(output).toBeFocused();

    await dialog.getByRole('button', { name: 'Hide run: build' }).click();
    await expect(output).toHaveCount(0);
  });

  test('a cut log says so', async ({ page }) => {
    await setup(page, {
      status: 200,
      body: { text: 'tail\n', truncated: true },
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await dialog.getByRole('button', { name: 'View run: build' }).click();

    await expect(dialog.locator('.run-output-note')).toContainText(
      'last 256 KB',
    );
    await expect(dialog.locator('.run-output-note')).toContainText('GitHub');
  });

  test('a refused read is a plain message, not the raw error', async ({
    page,
  }) => {
    await setup(page, {
      status: 403,
      body: { error: 'Resource not accessible' },
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await dialog.getByRole('button', { name: 'View run: build' }).click();

    await expect(dialog.locator('.run-output-error')).toContainText(
      "can't read this job's output",
    );
    await expect(dialog).not.toContainText('Resource not accessible');
    await expect(
      dialog.getByRole('button', { name: 'Copy output: build' }),
    ).toBeDisabled();
  });

  test('a check with no job id keeps the plain link', async ({ page }) => {
    await setup(page, { status: 200, body: { text: '', truncated: false } });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(
      dialog.getByRole('link', { name: 'View run: lint' }),
    ).toBeVisible();
  });
});
