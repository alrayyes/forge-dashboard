import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The pipeline checks dialog offers "Cancel run" for each queued or running
// Actions run, behind a confirm step that names the whole run, and shows the
// forge's own reason when it refuses. Neither forge can stop one job of a
// run, so the run is the unit. The page's EventSource is stubbed and the
// checks and the cancel are served by the test.

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function pr(allowed: { action: string }[]) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Add structured logging',
    url: 'https://example.com/42',
    author: 'claude',
    draft: false,
    ci: 'pending',
    checks: { passed: 1, running: 2, waiting: 0, failed: 0 },
    labels: [],
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    mergeStatus: 'blocked',
    status: 'blocked',
    kind: 'regular',
    behind: false,
    allowedActions: allowed,
  };
}

const RUNNING = [
  { name: 'build', state: 'success', url: 'https://example.com/r/1' },
  {
    name: 'lint',
    state: 'running',
    url: 'https://example.com/r/2',
    jobId: 2,
    runId: 77,
    runName: 'ci',
  },
  {
    name: 'test',
    state: 'queued',
    url: 'https://example.com/r/3',
    jobId: 3,
    runId: 77,
    runName: 'ci',
  },
  { name: 'external-ci', state: 'running', url: 'https://example.com/r/4' },
];

const STOPPED = [
  { name: 'build', state: 'success', url: 'https://example.com/r/1' },
  { name: 'lint', state: 'cancelled', url: 'https://example.com/r/2' },
  { name: 'test', state: 'cancelled', url: 'https://example.com/r/3' },
];

type Cancel = { status: number; body?: unknown };

declare global {
  interface Window {
    __push: (data: unknown) => void;
  }
}

const snapshot = (item: ReturnType<typeof pr>) => ({
  generatedAt: new Date().toISOString(),
  forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
  pullRequests: [item],
  issues: [],
});

async function open(
  page: Page,
  item: ReturnType<typeof pr>,
  state: {
    checks: unknown[];
    cancel?: Cancel;
    posted: unknown[];
    // Resolve to let a held cancel answer.
    hold?: Promise<void>;
    reads?: number;
  },
) {
  await page.addInitScript(() => {
    class StubEventSource {
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor() {
        (window as unknown as { __es: StubEventSource }).__es = this;
      }
      close() {}
      addEventListener() {}
    }
    (window as unknown as { EventSource: unknown }).EventSource =
      StubEventSource;
    window.__push = (data) =>
      (window as unknown as { __es: StubEventSource }).__es.onmessage?.({
        data: JSON.stringify(data),
      });
  });
  await page.route('**/api/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [item],
        issues: [],
      }),
    }),
  );
  await page.route('**/api/pull-requests/checks*', (route: Route) => {
    state.reads = (state.reads ?? 0) + 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ checks: state.checks }),
    });
  });
  await page.route('**/api/checks/cancel-run', async (route: Route) => {
    state.posted.push(route.request().postDataJSON());
    await state.hold;
    const answer = state.cancel ?? { status: 204 };
    return route.fulfill({
      status: answer.status,
      contentType: 'application/json',
      body: answer.body ? JSON.stringify(answer.body) : '',
    });
  });
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: 'Open pipeline' })
    .click();
  const dialog = page.locator('#pipeline-dialog');
  await expect(dialog.locator('.pipeline-check')).toHaveCount(
    state.checks.length,
  );

  return dialog;
}

// The confirm button fades in; a scan caught mid-fade reads a washed-out
// colour, so it runs with the animation off, as the other confirm specs do.
async function axeClean(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations).toEqual([]);
}

test.describe('cancel a running pipeline', () => {
  test('offers Cancel run for a running run, named for the workflow, and nothing for external CI', async ({
    page,
  }) => {
    const dialog = await open(page, pr([{ action: 'cancel_run' }]), {
      checks: RUNNING,
      posted: [],
    });

    await expect(
      dialog.getByRole('button', { name: 'Cancel run: ci' }),
    ).toBeVisible();
    // One run, one button: the external check belongs to no Actions run.
    await expect(
      dialog.getByRole('button', { name: /Cancel run/ }),
    ).toHaveCount(1);
  });

  test('offers nothing once every run has finished', async ({ page }) => {
    const dialog = await open(page, pr([{ action: 'cancel_run' }]), {
      checks: STOPPED,
      posted: [],
    });

    await expect(
      dialog.getByRole('button', { name: /Cancel run/ }),
    ).toHaveCount(0);
  });

  test('offers nothing when the server does not list cancel_run for the row', async ({
    page,
  }) => {
    const dialog = await open(page, pr([]), { checks: RUNNING, posted: [] });

    await expect(
      dialog.getByRole('button', { name: /Cancel run/ }),
    ).toHaveCount(0);
  });

  test('asks first, naming the whole run and the jobs that stop with it, and Keep running sends nothing', async ({
    page,
  }) => {
    const state = { checks: RUNNING, posted: [] as unknown[] };
    const dialog = await open(page, pr([{ action: 'cancel_run' }]), state);

    await dialog.getByRole('button', { name: 'Cancel run: ci' }).click();

    const confirm = dialog.getByRole('group', {
      name: 'Confirm cancelling ci',
    });
    await expect(confirm).toContainText('Cancel the whole run ci');
    await expect(confirm).toContainText('lint, test');
    await expect(confirm).not.toContainText('external-ci');
    expect(state.posted).toEqual([]);
    await axeClean(page);

    await confirm.getByRole('button', { name: 'Keep running' }).click();

    await expect(
      dialog.getByRole('button', { name: 'Cancel run: ci' }),
    ).toBeFocused();
    expect(state.posted).toEqual([]);
  });

  test('confirming cancels the run, shows it cancelling, then cancelled after the next read', async ({
    page,
  }) => {
    const state = { checks: RUNNING, posted: [] as unknown[] };
    const dialog = await open(page, pr([{ action: 'cancel_run' }]), state);

    await dialog.getByRole('button', { name: 'Cancel run: ci' }).click();
    await dialog.getByRole('button', { name: 'Yes, cancel run' }).click();

    await expect(
      dialog.getByRole('status').filter({ hasText: 'Cancelling ci' }),
    ).toBeVisible();
    expect(state.posted).toEqual([
      { forge: 'github', fullName: 'alrayyes/forge-dashboard', runId: 77 },
    ]);
    state.checks = STOPPED;

    await expect(
      dialog.getByRole('status').filter({ hasText: 'ci was cancelled' }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      dialog.getByRole('button', { name: /Cancel run/ }),
    ).toHaveCount(0);
  });

  test("shows the forge's own reason when it refuses, and leaves no broken button", async ({
    page,
  }) => {
    const state = {
      checks: RUNNING,
      posted: [] as unknown[],
      cancel: {
        status: 409,
        body: {
          error: 'x',
          code: 'conflict',
          message: 'Cannot cancel a workflow run that is completed.',
        },
      },
    };
    const dialog = await open(page, pr([{ action: 'cancel_run' }]), state);

    await dialog.getByRole('button', { name: 'Cancel run: ci' }).click();
    await dialog.getByRole('button', { name: 'Yes, cancel run' }).click();

    await expect(dialog.getByRole('alert')).toContainText(
      'Cannot cancel a workflow run that is completed.',
    );
    await expect(
      dialog.getByRole('button', { name: /Cancel run/ }),
    ).toHaveCount(0);
    await axeClean(page);
  });

  test('a token that may not cancel locks the action for the next time too', async ({
    page,
  }) => {
    const state = {
      checks: RUNNING,
      posted: [] as unknown[],
      cancel: {
        status: 403,
        body: {
          error: 'x',
          code: 'permission',
          message: 'Resource not accessible by integration',
        },
      },
    };
    const dialog = await open(page, pr([{ action: 'cancel_run' }]), state);
    await dialog.getByRole('button', { name: 'Cancel run: ci' }).click();
    await dialog.getByRole('button', { name: 'Yes, cancel run' }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'Resource not accessible by integration',
    );

    await dialog.getByRole('button', { name: 'Close pipeline checks' }).click();
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();

    await expect(dialog.locator('.pipeline-check')).toHaveCount(RUNNING.length);
    await expect(
      dialog.getByRole('button', { name: /Cancel run/ }),
    ).toHaveCount(0);
    await expect(dialog).toContainText(
      'Resource not accessible by integration',
    );
  });

  test('a refusal that lands after the dialog closed does not turn up in the next one', async ({
    page,
  }) => {
    let release: () => void = () => {};
    const state = {
      checks: RUNNING,
      posted: [] as unknown[],
      hold: new Promise<void>((resolve) => {
        release = resolve;
      }),
      cancel: {
        status: 409,
        body: {
          error: 'x',
          code: 'conflict',
          message: 'Cannot cancel a workflow run that is completed.',
        },
      },
    };
    const dialog = await open(page, pr([{ action: 'cancel_run' }]), state);
    await dialog.getByRole('button', { name: 'Cancel run: ci' }).click();
    await dialog.getByRole('button', { name: 'Yes, cancel run' }).click();
    await expect.poll(() => state.posted.length).toBe(1);

    await dialog.getByRole('button', { name: 'Close pipeline checks' }).click();
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    await expect(dialog.locator('.pipeline-check')).toHaveCount(RUNNING.length);
    release();
    await page.waitForTimeout(500);

    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Cancel run: ci' }),
    ).toBeVisible();
  });

  test('a run that finishes while its confirm is open stops asking', async ({
    page,
  }) => {
    const state = { checks: RUNNING, posted: [] as unknown[] };
    const dialog = await open(page, pr([{ action: 'cancel_run' }]), state);
    await dialog.getByRole('button', { name: 'Cancel run: ci' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Yes, cancel run' }),
    ).toBeVisible();

    state.checks = STOPPED;
    await page.evaluate(
      (item) => window.__push(item),
      snapshot({
        ...pr([{ action: 'cancel_run' }]),
        ci: 'success',
        checks: { passed: 3, running: 0, waiting: 0, failed: 0 },
      }),
    );

    await expect(
      dialog.getByRole('button', { name: 'Yes, cancel run' }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: /Cancel run/ }),
    ).toHaveCount(0);
    expect(state.posted).toEqual([]);
  });

  test('a run with no readable jobs is cancellable and is not said to have a job named for itself', async ({
    page,
  }) => {
    const standIn = [
      {
        name: 'ci',
        state: 'running',
        url: 'https://example.com/r/9',
        runId: 9,
        runName: 'ci',
      },
    ];
    const dialog = await open(page, pr([{ action: 'cancel_run' }]), {
      checks: standIn,
      posted: [],
    });

    await dialog.getByRole('button', { name: 'Cancel run: ci' }).click();

    const confirm = dialog.getByRole('group', {
      name: 'Confirm cancelling ci',
    });
    await expect(confirm).toContainText('everything still going in it');
    await expect(confirm).not.toContainText('unfinished job');
  });

  test('a cancel the forge accepted but the run outlasts ends as still running, with the button back, and a close stops the reads', async ({
    page,
  }) => {
    await page.clock.install();
    const state = { checks: RUNNING, posted: [] as unknown[], reads: 0 };
    const dialog = await open(page, pr([{ action: 'cancel_run' }]), state);
    await dialog.getByRole('button', { name: 'Cancel run: ci' }).click();
    await dialog.getByRole('button', { name: 'Yes, cancel run' }).click();
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Cancelling ci' }),
    ).toBeVisible();

    // Eight re-reads, 2.5 seconds apart, and the run is still going.
    await page.clock.runFor(2500 * 9);

    await expect(
      dialog.getByRole('status').filter({ hasText: 'still running' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Cancelling ci' }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Cancel run: ci' }),
    ).toBeVisible();

    // And the reads stop for good: none happen after the cap.
    const after = state.reads;
    await page.clock.runFor(2500 * 4);
    expect(state.reads).toBe(after);
  });

  test('closing the dialog while a run is cancelling stops the re-reads', async ({
    page,
  }) => {
    await page.clock.install();
    const state = { checks: RUNNING, posted: [] as unknown[], reads: 0 };
    const dialog = await open(page, pr([{ action: 'cancel_run' }]), state);
    await dialog.getByRole('button', { name: 'Cancel run: ci' }).click();
    await dialog.getByRole('button', { name: 'Yes, cancel run' }).click();
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Cancelling ci' }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Close pipeline checks' }).click();
    const after = state.reads;

    await page.clock.runFor(2500 * 4);

    expect(state.reads).toBe(after);
  });

  test('a permission refusal is forgotten after a while, so a fixed token works', async ({
    page,
  }) => {
    await page.clock.install();
    const state = {
      checks: RUNNING,
      posted: [] as unknown[],
      cancel: {
        status: 403,
        body: {
          error: 'x',
          code: 'permission',
          message: 'Resource not accessible by integration',
        },
      },
    };
    const dialog = await open(page, pr([{ action: 'cancel_run' }]), state);
    await dialog.getByRole('button', { name: 'Cancel run: ci' }).click();
    await dialog.getByRole('button', { name: 'Yes, cancel run' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close pipeline checks' }).click();

    await page.clock.runFor(6 * 60_000);
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();

    await expect(
      dialog.getByRole('button', { name: 'Cancel run: ci' }),
    ).toBeVisible();
  });
  test('the Main branches dialog offers it too, with no allowed-actions list to ask', async ({
    page,
  }) => {
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
    await page.route('**/api/main-branches', (route) =>
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
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          branches: [
            {
              forge: 'github',
              fullName: 'acme/auth-service',
              url: 'https://example.com/acme/auth-service',
              branch: 'main',
              status: 'running',
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
              checks: { passed: 0, running: 2, waiting: 0, failed: 0 },
              stale: false,
              staleSince: null,
            },
          ],
        }),
      }),
    );
    await page.route('**/api/main-branches/checks*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ checks: RUNNING.slice(1, 3) }),
      }),
    );
    await page.goto('/');
    await page
      .getByRole('button', { name: /open pipeline/i })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: /pipeline/i });

    await expect(
      dialog.getByRole('button', { name: 'Cancel run: ci' }),
    ).toBeVisible();
  });
});
