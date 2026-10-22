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

// A browser that has no async clipboard and refuses the selection copy.
async function refuseClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined });
    document.execCommand = () => false;
  });
}

async function setup(
  page: Page,
  log: { status: number; body: unknown },
  checks: unknown[] = [
    {
      name: 'build',
      state: 'failure',
      url: runUrl,
      jobId: 9,
      excerpt: 'boom: exit 1',
    },
    { name: 'lint', state: 'success', url: `${runUrl}0` },
  ],
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
      body: JSON.stringify({ checks }),
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

  test('a failed check has a Copy log button beside its excerpt that copies the whole log', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const asked = await setup(page, {
      status: 200,
      body: { text: 'step 1\nboom: exit 1\n', truncated: false },
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const copy = dialog.getByRole('button', { name: 'Copy log: build' });

    await copy.focus();
    await page.keyboard.press('Enter');

    await expect(dialog.locator('.pipeline-check-copy-status')).toHaveText(
      'Copied',
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'step 1\nboom: exit 1\n',
    );
    expect(new URL(asked[0]).searchParams.get('jobId')).toBe('9');
    const results = await new AxeBuilder({ page })
      .include('#pipeline-dialog')
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('when the full log cannot be read, Copy log copies the excerpt and says so', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setup(page, { status: 404, body: { error: 'gone' } });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await dialog.getByRole('button', { name: 'Copy log: build' }).click();

    await expect(dialog.locator('.pipeline-check-copy-status')).toHaveText(
      /^Copied the excerpt only\. .*no output for this job/,
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'boom: exit 1',
    );
  });

  test('a failed job with no excerpt still has Copy log, and no excerpt box', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setup(
      page,
      { status: 200, body: { text: 'whole log\n', truncated: false } },
      [{ name: 'build', state: 'failure', url: runUrl, jobId: 9 }],
    );
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await expect(dialog.locator('.pipeline-check-excerpt')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Copy log: build' }).click();

    await expect(dialog.locator('.pipeline-check-copy-status')).toHaveText(
      'Copied',
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'whole log\n',
    );
  });

  test('a failed job with no excerpt and an unreadable log copies nothing and says why', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setup(page, { status: 404, body: {} }, [
      { name: 'build', state: 'failure', url: runUrl, jobId: 9 },
    ]);
    await page.evaluate(() => navigator.clipboard.writeText('keep me'));
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await dialog.getByRole('button', { name: 'Copy log: build' }).click();

    await expect(dialog.locator('.pipeline-check-copy-status')).toContainText(
      'Nothing was copied',
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'keep me',
    );
    await expect(
      dialog.getByRole('button', { name: 'Copy log: build' }),
    ).not.toHaveAttribute('aria-disabled');
  });

  test('a failed check with no job and no excerpt has nothing to copy', async ({
    page,
  }) => {
    await setup(page, { status: 200, body: {} }, [
      { name: 'build', state: 'failure', url: runUrl },
    ]);
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await expect(
      dialog.getByRole('button', { name: 'Copy log: build' }),
    ).toHaveCount(0);
  });

  test('a passed check has no Copy log button', async ({ page }) => {
    await setup(page, { status: 200, body: { text: '', truncated: false } });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(
      dialog.getByRole('button', { name: 'Copy log: lint' }),
    ).toHaveCount(0);
  });

  test('when the clipboard refuses, the status does not claim anything was copied', async ({
    page,
  }) => {
    await refuseClipboard(page);
    await setup(page, {
      status: 200,
      body: { text: 'whole\n', truncated: false },
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await dialog.getByRole('button', { name: 'Copy log: build' }).click();

    await expect(dialog.locator('.pipeline-check-copy-status')).toContainText(
      "Couldn't copy automatically",
    );
  });

  test('a log the server cut says so when copied', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setup(page, {
      status: 200,
      body: { text: 'tail\n', truncated: true },
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await dialog.getByRole('button', { name: 'Copy log: build' }).click();

    await expect(dialog.locator('.pipeline-check-copy-status')).toContainText(
      'Copied the last 256 KB',
    );
  });

  test('a signed-out session says to sign in, and the button keeps focus while loading', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setup(page, { status: 401, body: {} });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/checks/log*', async (route) => {
      await held;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: '{}',
      });
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const copy = dialog.getByRole('button', { name: 'Copy log: build' });

    await copy.focus();
    await page.keyboard.press('Enter');

    const status = dialog.locator('.pipeline-check-copy-status');
    await expect(status).toHaveText('Copying');
    await expect(copy).toHaveAttribute('aria-busy', 'true');
    await expect(copy).toBeFocused();
    release();
    await expect(status).toContainText('Sign in again');
    await expect(copy).toBeFocused();
    await expect(copy).not.toHaveAttribute('aria-busy');
  });

  test('closing the dialog while the log is read leaves no error behind', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setup(page, { status: 200, body: { text: 'x', truncated: false } });
    const errors: Error[] = [];
    page.on('pageerror', (e) => errors.push(e));
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/checks/log*', async (route) => {
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: 'x', truncated: false }),
      });
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await dialog.getByRole('button', { name: 'Copy log: build' }).click();
    await page.keyboard.press('Escape');
    release();
    await page.waitForTimeout(200);

    expect(errors).toEqual([]);
  });

  test('when every copy route is refused the whole log is selected in a field and the instruction stays', async ({
    page,
  }) => {
    await refuseClipboard(page);
    await setup(page, {
      status: 200,
      body: { text: 'line one\nline two\n', truncated: false },
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await dialog.getByRole('button', { name: 'Copy log: build' }).click();

    const field = dialog.getByRole('textbox', { name: 'Log to copy: build' });
    await expect(field).toHaveValue('line one\nline two\n');
    await expect(field).toBeFocused();
    expect(
      await field.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([0, 18]);
    const status = dialog.locator('.pipeline-check-copy-status');
    await expect(status).toContainText('Cmd+C');
    await expect(status).toContainText('The log is selected below');
  });
  test('pressing Copy log again keeps the field to copy from until the new log arrives', async ({
    page,
  }) => {
    await refuseClipboard(page);
    await setup(page, {
      status: 200,
      body: { text: 'first log\n', truncated: false },
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const field = dialog.getByRole('textbox', { name: 'Log to copy: build' });
    await dialog.getByRole('button', { name: 'Copy log: build' }).click();
    await expect(field).toHaveValue('first log\n');

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/checks/log*', async (route: Route) => {
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: 'second log\n', truncated: false }),
      });
    });
    await field.focus();
    await dialog
      .getByRole('button', { name: 'Copy log: build' })
      .press('Enter');

    await expect(dialog.locator('.pipeline-check-copy-status')).toHaveText(
      'Copying',
    );
    await expect(field).toHaveValue('first log\n');
    release();
    await expect(field).toHaveValue('second log\n');
  });
});

// The Main branches pipeline dialog for one failed check whose job the test
// can change; `state` is read by the routes, and a poll shows the change.
async function openBranchFailure(
  page: Page,
  log?: (jobId: number) => Promise<void>,
) {
  const row = (failed: number) => ({
    forge: 'github',
    fullName: 'acme/auth-service',
    url: 'https://example.com/acme/auth-service',
    branch: 'main',
    status: 'failed',
    commit: {
      sha: 'd98f3c2',
      subject: 'fix: change',
      author: 'sre-dev',
      committedAt: new Date(Date.now() - 1800_000).toISOString(),
    },
    failingJobs: [],
    finishedAt: null,
    durationSeconds: null,
    runUrl: 'https://example.com/acme/auth-service/actions/runs/1',
    checks: { passed: 0, running: 0, waiting: 0, failed },
    stale: false,
    staleSince: null,
  });
  const state = { failed: 1, jobId: 9, excerpt: 'old boom' };
  await page.clock.install();
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 1,
          passed: 0,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: 1,
        },
        branches: [row(state.failed)],
      }),
    }),
  );
  await page.route('**/api/main-branches/checks*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        checks: [
          {
            name: 'build',
            state: 'failure',
            url: 'https://example.com/r/1',
            jobId: state.jobId,
            excerpt: state.excerpt,
          },
        ],
      }),
    }),
  );
  await page.route('**/api/checks/log*', async (route: Route) => {
    await log?.(state.jobId);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        text: `log of job ${state.jobId}\n`,
        truncated: false,
      }),
    });
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: /open pipeline/i })
    .first()
    .click();

  return {
    dialog: page.getByRole('dialog', { name: /pipeline/i }),
    state,
    poll: async () => {
      state.failed++;
      await page.clock.runFor(60_000);
    },
    rerun: async () => {
      state.failed = 2;
      state.jobId = 10;
      state.excerpt = 'new boom';
      await page.clock.runFor(60_000);
    },
  };
}

test.describe('a rerun gives a failed check a new job', () => {
  test('the field to copy from and its instruction go, so the old log cannot be pasted for the new run', async ({
    page,
  }) => {
    await refuseClipboard(page);
    const { dialog, rerun } = await openBranchFailure(page);
    await dialog.getByRole('button', { name: 'Copy log: build' }).click();
    const field = dialog.getByRole('textbox', { name: 'Log to copy: build' });
    await expect(field).toHaveValue('log of job 9\n');

    await rerun();

    await expect(dialog.locator('.pipeline-check-excerpt')).toHaveText(
      'new boom',
    );
    await expect(field).toHaveCount(0);
    await expect(dialog.locator('.pipeline-check-copy-status')).toHaveText('');
  });

  test('a later excerpt of the same job keeps the field to copy from', async ({
    page,
  }) => {
    await refuseClipboard(page);
    const { dialog, state, poll } = await openBranchFailure(page);
    await dialog.getByRole('button', { name: 'Copy log: build' }).click();
    const field = dialog.getByRole('textbox', { name: 'Log to copy: build' });
    await expect(field).toHaveValue('log of job 9\n');

    state.excerpt = 'a later line of the same job';
    await poll();

    await expect(dialog.locator('.pipeline-check-excerpt')).toHaveText(
      'a later line of the same job',
    );
    await expect(field).toHaveValue('log of job 9\n');
  });

  test('a log still loading when the check is rerun is not written to the clipboard', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { dialog, rerun } = await openBranchFailure(page, () => held);
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));

    await dialog.getByRole('button', { name: 'Copy log: build' }).click();
    await expect(dialog.locator('.pipeline-check-copy-status')).toHaveText(
      'Copying',
    );
    await rerun();
    await expect(dialog.locator('.pipeline-check-excerpt')).toHaveText(
      'new boom',
    );
    release();
    await page.waitForTimeout(300);

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'SENTINEL',
    );
  });
});

test.describe('the copy status line', () => {
  test('a selection that throws leaves no hidden field behind and still offers the field to copy from', async ({
    page,
  }) => {
    await refuseClipboard(page);
    await page.addInitScript(() => {
      const select = HTMLTextAreaElement.prototype.select;
      HTMLTextAreaElement.prototype.select = function () {
        // Only the hidden field the copy makes has no label.
        if (!this.hasAttribute('aria-label')) throw new Error('no selection');
        select.call(this);
      };
    });
    await setup(page, {
      status: 200,
      body: { text: 'old log\n', truncated: false },
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await dialog.getByRole('button', { name: 'Copy log: build' }).click();

    await expect(
      dialog.getByRole('textbox', { name: 'Log to copy: build' }),
    ).toHaveValue('old log\n');
    await expect(dialog.locator('textarea:not([aria-label])')).toHaveCount(0);
    await expect(dialog.locator('.pipeline-check-copy-status')).toContainText(
      'Cmd+C',
    );
  });

  test('a dialog closed while the log loads is not copied into', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { tries: number };
      w.tries = 0;
      Object.defineProperty(navigator, 'clipboard', { value: undefined });
      document.execCommand = () => {
        w.tries++;

        return false;
      };
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await setup(page, {
      status: 200,
      body: { text: 'x', truncated: false },
    });
    await page.route('**/api/checks/log*', async (route) => {
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: 'x', truncated: false }),
      });
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await dialog.getByRole('button', { name: 'Copy log: build' }).click();
    await page.keyboard.press('Escape');
    release();
    await page.waitForTimeout(200);

    expect(
      await page.evaluate(() => (window as unknown as { tries: number }).tries),
    ).toBe(0);
  });

  test('a second Copied inside ten seconds is announced again', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setup(page, {
      status: 200,
      body: { text: 'a log\n', truncated: false },
    });
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const button = dialog.getByRole('button', { name: 'Copy log: build' });
    const status = dialog.locator('.pipeline-check-copy-status');
    await button.click();
    await expect(status).toHaveText('Copied');
    await status.evaluate((el) => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      new MutationObserver(() => seen.push(el.textContent ?? '')).observe(el, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });

    await button.click();
    await expect(status).toHaveText('Copied');

    const seen = await page.evaluate(
      () => (window as unknown as { seen: string[] }).seen,
    );
    expect(seen).toEqual(['Copying', 'Copied']);
  });
});
