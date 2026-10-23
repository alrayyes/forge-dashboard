import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Main branches pipeline dialog offers "Rerun failed checks" on a failed
// branch, as the pull request dialog does.

function branch(status: 'failed' | 'passed', running = 0) {
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
    checks: { passed: 1, running, waiting: 0, failed: failed ? 1 : 0 },
    stale: false,
    staleSince: null,
  };
}

async function openPanel(
  page: Page,
  status: 'failed' | 'passed',
  state: {
    checks: unknown[];
    running?: number;
    forges?: unknown[];
    row?: Record<string, unknown>;
    checksGate?: Promise<void>;
  } = {
    checks: [
      {
        name: 'test',
        state: status === 'failed' ? 'failure' : 'success',
        url: 'https://example.com/r/2',
      },
    ],
  },
) {
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
        forges: state.forges ?? [
          { forge: 'github', reachable: true, repoCount: 1 },
        ],
        branches: [{ ...branch(status, state.running ?? 0), ...state.row }],
      }),
    }),
  );
  await page.route('**/api/main-branches/checks*', async (route) => {
    await state.checksGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ checks: state.checks }),
    });
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: /open pipeline/i })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: /pipeline/i });
  await expect(dialog.getByRole('listitem')).toHaveCount(state.checks.length);
  return dialog;
}

// Steps the page's clock until its own poll of the branches has gone out,
// whatever the interval is. It returns once the request is seen, before the
// answer is fulfilled, so the next step must be an auto-waiting expect.
async function runUntilPolled(page: Page) {
  let polled = false;
  page.on('request', (req) => {
    if (req.url().endsWith('/api/main-branches')) polled = true;
  });
  for (let i = 0; i < 120 && !polled; i++) await page.clock.runFor(5_000);
  expect(polled).toBe(true);
}

test.describe('main branches rerun failed checks', () => {
  test('a poll that redraws the control mid-request still shows the in-flight state, then the refusal', async ({
    page,
  }) => {
    await page.clock.install();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/main-branches/rerun-checks', async (route) => {
      await gate;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'not_mergeable',
          message: 'no failed job to rerun on this branch',
          error: 'no failed job to rerun on this branch',
        }),
      });
    });
    const state = {
      running: 1,
      checks: [
        { name: 'build', state: 'running', url: 'https://example.com/r/1' },
        { name: 'test', state: 'failure', url: 'https://example.com/r/2' },
      ],
    };
    const dialog = await openPanel(page, 'failed', state);

    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await expect(dialog.getByRole('status')).toContainText('Queuing the rerun');

    // The page's poll finds a check moved, so the dialog draws the control
    // again while the request is still out.
    state.running = 0;
    state.checks = [
      { name: 'build', state: 'success', url: 'https://example.com/r/1' },
      { name: 'test', state: 'failure', url: 'https://example.com/r/2' },
    ];
    await page.clock.runFor(60_000);
    await expect(dialog.getByRole('listitem').first()).toContainText('Passed');
    await expect(dialog.getByRole('status')).toContainText('Queuing the rerun');
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toHaveAttribute('aria-disabled', 'true');

    release();

    await expect(dialog.getByRole('alert')).toContainText(
      'no failed job to rerun on this branch',
    );
    await expect(dialog.getByRole('status')).toHaveText('');
  });

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

  test('the hold ends on its own when the ten minutes pass with no poll to redraw the dialog', async ({
    page,
  }) => {
    await page.clock.install();
    await page.route('**/api/main-branches/rerun-checks', (route) =>
      route.fulfill({ status: 204 }),
    );
    const dialog = await openPanel(page, 'failed');
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Rerun queued' }),
    ).toHaveAttribute('aria-disabled', 'true');

    // From here every poll hangs, so only the hold's own timer can redraw.
    await page.route('**/api/main-branches', () => {});
    await page.clock.fastForward(10 * 60 * 1000 + 5_000);

    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByRole('status')).toHaveText('');
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

  test('a queued rerun clears the moment a poll shows a newer commit, before the checks reload', async ({
    page,
  }) => {
    await page.clock.install();
    await page.route('**/api/main-branches/rerun-checks', (route) =>
      route.fulfill({ status: 204 }),
    );
    const state: {
      checks: unknown[];
      row?: Record<string, unknown>;
      checksGate?: Promise<void>;
    } = {
      checks: [
        { name: 'test', state: 'failure', url: 'https://example.com/r/2' },
      ],
    };
    const dialog = await openPanel(page, 'failed', state);
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Rerun queued' }),
    ).toBeVisible();

    // The branch moves to a new commit and its checks are slow to load.
    let release: () => void = () => {};
    state.checksGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.row = {
      commit: { ...branch('failed').commit, sha: 'a1b2c3d' },
      runUrl: 'https://example.com/acme/auth-service/actions/runs/2',
    };
    await page.clock.runFor(60_000);

    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByRole('status')).toHaveText('');
    release();
  });

  test('a passing branch has no button', async ({ page }) => {
    const dialog = await openPanel(page, 'passed');

    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);
  });

  const failedCheck = [
    { name: 'test', state: 'failure', url: 'https://example.com/r/2' },
  ];

  test('an unreachable forge gets no Rerun button, only the reason', async ({
    page,
  }) => {
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges: [{ forge: 'github', reachable: false, repoCount: 1 }],
    });

    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);
    await expect(dialog.getByRole('status')).toHaveText(
      "This forge can't be reached right now.",
    );
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a forge out of REST budget gets no Rerun button and says when it resumes', async ({
    page,
  }) => {
    const resetsAt = new Date(Date.now() + 20 * 60_000).toISOString();
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges: [
        {
          forge: 'github',
          reachable: true,
          repoCount: 1,
          rateLimitREST: {
            limit: 5000,
            remaining: 0,
            resetsAt,
            severity: 'exceeded',
          },
        },
      ],
    });

    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);
    await expect(dialog.getByRole('status')).toContainText(
      /^GitHub API rate limit reached\. Actions resume at .+ \(in \d+ min\)\.$/,
    );
  });

  test('the button comes back when a poll shows the forge reachable again', async ({
    page,
  }) => {
    const forges: unknown[] = [
      { forge: 'github', reachable: false, repoCount: 1 },
    ];
    await page.clock.install();
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges,
    });
    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);

    forges[0] = { forge: 'github', reachable: true, repoCount: 1 };

    // Step the clock until the page's own poll has run, whatever its interval.
    await runUntilPolled(page);

    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeVisible();
  });

  test('the button comes back when the rate limit resets between polls', async ({
    page,
  }) => {
    await page.clock.install();
    const resetsAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges: [
        {
          forge: 'github',
          reachable: true,
          repoCount: 1,
          rateLimitREST: {
            limit: 5000,
            remaining: 0,
            resetsAt,
            severity: 'exceeded',
          },
        },
      ],
    });
    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);

    // No poll answers from here, so only the reset itself can bring it back.
    await page.route('**/api/main-branches', () => {});
    await page.clock.runFor(5 * 60_000 + 1_000);

    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeVisible();
    await expect(dialog.getByRole('status')).toHaveText('');
  });

  test('a lock keeps the queued status and hides an earlier failure', async ({
    page,
  }) => {
    const forges: unknown[] = [
      { forge: 'github', reachable: true, repoCount: 1 },
    ];
    await page.route('**/api/main-branches/rerun-checks', (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.clock.install();
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges,
    });
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await expect(dialog.getByRole('status')).toContainText('Rerun queued');

    forges[0] = { forge: 'github', reachable: false, repoCount: 1 };
    await runUntilPolled(page);

    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);
    await expect(dialog.getByRole('status')).toContainText('Rerun queued');
    await expect(dialog.getByRole('status')).toContainText(
      "This forge can't be reached right now.",
    );
  });

  test('a second host of the same forge kind that is healthy keeps the button', async ({
    page,
  }) => {
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges: [
        { forge: 'github', reachable: false, repoCount: 1 },
        { forge: 'github', reachable: true, repoCount: 2 },
      ],
    });

    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeVisible();
  });

  const spentUntil = (minutes: number) => ({
    limit: 5000,
    remaining: 0,
    resetsAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    severity: 'exceeded',
  });

  for (const [name, forges] of [
    [
      'the later reset comes first',
      () => [
        { forge: 'github', reachable: true, rateLimitREST: spentUntil(10) },
        { forge: 'github', reachable: true, rateLimitREST: spentUntil(5) },
      ],
    ],
    [
      'the first host is unreachable',
      () => [
        { forge: 'github', reachable: false },
        { forge: 'github', reachable: true, rateLimitREST: spentUntil(5) },
      ],
    ],
  ] as const) {
    test(`with several locked hosts the button returns at the earliest reset (${name})`, async ({
      page,
    }) => {
      await page.clock.install();
      const dialog = await openPanel(page, 'failed', {
        checks: failedCheck,
        forges: forges(),
      });
      await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(
        0,
      );

      await page.route('**/api/main-branches', () => {});
      await page.clock.runFor(5 * 60_000 + 1_000);

      await expect(
        dialog.getByRole('button', { name: 'Rerun failed checks' }),
      ).toBeVisible();
    });
  }

  const refuse = (route: Route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'not_mergeable',
        message: 'no failed job to rerun on this branch',
        error: 'no failed job to rerun on this branch',
      }),
    });

  // A forge answering 503 is the outage itself: the line says nothing once the
  // forge is known to be down, and nothing true once it is back.
  const unavailable = (route: Route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'The forge is down.' }),
    });

  test('an earlier outage failure does not come back after a lock lifts', async ({
    page,
  }) => {
    const forges: unknown[] = [
      { forge: 'github', reachable: true, repoCount: 1 },
    ];
    await page.route('**/api/main-branches/rerun-checks', unavailable);
    await page.clock.install();
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges,
    });
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await expect(dialog.getByRole('alert')).toContainText('forge is down');

    forges[0] = { forge: 'github', reachable: false, repoCount: 1 };
    await runUntilPolled(page);
    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);

    forges[0] = { forge: 'github', reachable: true, repoCount: 1 };
    await runUntilPolled(page);
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  });

  test('a permission refusal is still shown after an outage passes', async ({
    page,
  }) => {
    const forges: unknown[] = [
      { forge: 'github', reachable: true, repoCount: 1 },
    ];
    await page.route('**/api/main-branches/rerun-checks', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'permission',
          message: 'The token cannot rerun workflows.',
        }),
      }),
    );
    await page.clock.install();
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges,
    });
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await expect(dialog.getByRole('alert')).toContainText('cannot rerun');

    forges[0] = { forge: 'github', reachable: false, repoCount: 1 };
    await runUntilPolled(page);
    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);

    forges[0] = { forge: 'github', reachable: true, repoCount: 1 };
    await runUntilPolled(page);
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('cannot rerun');
  });

  test('a poll leaves the failure box, and the focus on its Copy button, alone', async ({
    page,
  }) => {
    await page.route('**/api/main-branches/rerun-checks', refuse);
    await page.clock.install();
    const dialog = await openPanel(page, 'failed', { checks: failedCheck });
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    const copy = dialog.getByRole('button', { name: 'Copy error details' });
    await copy.focus();
    await copy.evaluate((el) => el.setAttribute('data-mark', 'same'));

    await runUntilPolled(page);

    await expect(copy).toBeFocused();
    await expect(copy).toHaveAttribute('data-mark', 'same');
  });

  test('keyboard focus stays in the dialog when a poll takes the button away', async ({
    page,
  }) => {
    const forges: unknown[] = [
      { forge: 'github', reachable: true, repoCount: 1 },
    ];
    await page.clock.install();
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges,
    });
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).focus();

    forges[0] = { forge: 'github', reachable: false, repoCount: 1 };
    await runUntilPolled(page);

    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);
    await expect(
      page.evaluate(
        () =>
          document.activeElement?.closest('dialog, [role="dialog"]') != null,
      ),
    ).resolves.toBe(true);
  });

  test('keyboard focus stays in the dialog when a lock removes the Copy button', async ({
    page,
  }) => {
    const forges: unknown[] = [
      { forge: 'github', reachable: true, repoCount: 1 },
    ];
    await page.route('**/api/main-branches/rerun-checks', unavailable);
    await page.clock.install();
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges,
    });
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    const copy = dialog.getByRole('button', { name: 'Copy error details' });
    await copy.focus();

    forges[0] = { forge: 'github', reachable: false, repoCount: 1 };
    await runUntilPolled(page);

    await expect(copy).toHaveCount(0);
    await expect(
      page.evaluate(
        () =>
          document.activeElement?.closest('dialog, [role="dialog"]') != null,
      ),
    ).resolves.toBe(true);
  });

  test('keyboard focus returns to the button when the lock lifts', async ({
    page,
  }) => {
    const forges: unknown[] = [
      { forge: 'github', reachable: true, repoCount: 1 },
    ];
    await page.clock.install();
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges,
    });
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).focus();
    forges[0] = { forge: 'github', reachable: false, repoCount: 1 };
    await runUntilPolled(page);
    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);

    forges[0] = { forge: 'github', reachable: true, repoCount: 1 };
    await runUntilPolled(page);

    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeFocused();
    await expect(dialog.locator('.pipeline-rerun')).not.toHaveAttribute(
      'tabindex',
      /.*/,
    );
  });

  test('a reset far in the future keeps the button away without looping', async ({
    page,
  }) => {
    await page.clock.install();
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges: [
        {
          forge: 'github',
          reachable: true,
          rateLimitREST: spentUntil(60 * 24 * 40),
        },
      ],
    });
    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);

    await page.route('**/api/main-branches', () => {});
    await page.clock.runFor(11 * 60_000);

    await expect(dialog.getByRole('button', { name: /rerun/i })).toHaveCount(0);
    await expect(dialog.getByRole('status')).toContainText('rate limit');
  });

  test('a forge entry that does not say whether it is reachable does not lock', async ({
    page,
  }) => {
    const dialog = await openPanel(page, 'failed', {
      checks: failedCheck,
      forges: [{ forge: 'github', repoCount: 1 }],
    });

    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeVisible();
  });
});
