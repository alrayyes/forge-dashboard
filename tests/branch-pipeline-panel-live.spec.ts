import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Main branches pipeline panel reads its checks again only when the row's
// own CI changed in the page's poll: no request while nothing changes, none for
// a finished pipeline.

type Counts = {
  passed: number;
  running: number;
  waiting: number;
  failed: number;
};

function branch(status: string, checks: Counts) {
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
    failingJobs: [],
    finishedAt: null,
    durationSeconds: null,
    runUrl: 'https://example.com/acme/auth-service/actions/runs/1',
    checks,
    stale: false,
    staleSince: null,
  };
}

const RUNNING = branch('running', {
  passed: 1,
  running: 1,
  waiting: 0,
  failed: 0,
});
const PASSED = branch('passed', {
  passed: 2,
  running: 0,
  waiting: 0,
  failed: 0,
});

const RUN = [
  { name: 'build', state: 'success', url: 'https://example.com/r/1' },
  { name: 'test', state: 'running', url: 'https://example.com/r/2' },
];
const DONE = [
  { name: 'build', state: 'success', url: 'https://example.com/r/1' },
  { name: 'test', state: 'success', url: 'https://example.com/r/2' },
];

function snapshot(b: ReturnType<typeof branch>) {
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      failed: 0,
      passed: b.status === 'passed' ? 1 : 0,
      running: b.status === 'running' ? 1 : 0,
      cancelled: 0,
      awaitingApproval: 0,
      none: 0,
      total: 1,
    },
    branches: [b],
  };
}

async function open(
  page: Page,
  first: ReturnType<typeof branch>,
  checks: unknown[],
  count = 2,
) {
  const state = { row: first, checks, requests: 0, status: 200 };
  await page.clock.install();
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(state.row)),
    }),
  );
  await page.route('**/api/main-branches/checks*', (route: Route) => {
    state.requests++;
    return route.fulfill({
      status: state.status,
      contentType: 'application/json',
      body: JSON.stringify(
        state.status === 200
          ? { checks: state.checks }
          : { error: 'forge unreachable' },
      ),
    });
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: /open pipeline/i })
    .first()
    .click();
  await expect(panel(page).getByRole('listitem')).toHaveCount(count);

  return state;
}

const panel = (page: Page) => page.getByRole('dialog', { name: /pipeline/i });
// The page's own poll, one interval on.
const poll = (page: Page) => page.clock.runFor(60_000);

test.describe('main branches pipeline panel updates live', () => {
  test('a check finishing changes its pill where it stands, announced once', async ({
    page,
  }) => {
    const state = await open(page, RUNNING, RUN);
    const items = panel(page).getByRole('listitem');
    await expect(items.nth(1)).toContainText('Running');

    state.row = PASSED;
    state.checks = DONE;
    await poll(page);

    await expect(items.nth(1)).toContainText('Passed');
    await expect(items.nth(0)).toContainText('build');
    expect(state.requests).toBe(2);
    await expect(
      panel(page).getByText('Checks updated: test is now Passed.'),
    ).toBeAttached();
  });

  test('a redraw keeps focus on the same check when an earlier one is gone', async ({
    page,
  }) => {
    const three = [
      { name: 'lint', state: 'running', url: 'https://example.com/r/0' },
      { name: 'build', state: 'success', url: 'https://example.com/r/1' },
      { name: 'test', state: 'running', url: 'https://example.com/r/2' },
    ];
    const state = await open(page, RUNNING, three, 3);
    await panel(page)
      .getByRole('link', { name: 'View run (opens in a new tab): test' })
      .focus();

    state.row = PASSED;
    state.checks = DONE;
    await poll(page);

    await expect(panel(page).getByRole('listitem')).toHaveCount(2);
    await expect(
      panel(page).getByRole('link', {
        name: 'View run (opens in a new tab): test',
      }),
    ).toBeFocused();
  });

  test('a redraw moves focus to the close button when its check is gone', async ({
    page,
  }) => {
    const state = await open(page, RUNNING, RUN);
    await panel(page)
      .getByRole('link', { name: 'View run (opens in a new tab): test' })
      .focus();

    state.row = PASSED;
    state.checks = [
      { name: 'build', state: 'failure', url: 'https://example.com/r/1' },
    ];
    await poll(page);

    await expect(panel(page).getByRole('listitem')).toHaveCount(1);
    await expect(
      panel(page).getByRole('button', { name: /close/i }),
    ).toBeFocused();
  });

  test('closing the panel after the row redrew its pill returns focus to the pill', async ({
    page,
  }) => {
    const state = await open(page, RUNNING, RUN);
    state.row = PASSED;
    state.checks = DONE;
    await poll(page);
    await expect(panel(page).getByRole('listitem').nth(1)).toContainText(
      'Passed',
    );

    await panel(page).getByRole('button', { name: /close/i }).click();

    await expect(
      page.getByRole('button', { name: /^Passed.*open pipeline/i }),
    ).toBeFocused();
  });

  test('a poll that changes the row between press and release still opens the panel', async ({
    page,
  }) => {
    const state = await open(page, RUNNING, RUN);
    await panel(page).getByRole('button', { name: /close/i }).click();
    await expect(panel(page)).toBeHidden();

    const pill = page.getByRole('button', { name: /open pipeline/i }).first();
    const box = (await pill.boundingBox())!;
    // On the leading word, which the poll replaces. A count change keeps the
    // status, so nothing on the page moves out from under the pointer.
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    await page.mouse.down();
    state.row = branch('running', {
      passed: 2,
      running: 1,
      waiting: 0,
      failed: 0,
    });
    await poll(page);
    await expect(
      page.getByRole('button', { name: /open pipeline/i }).first(),
    ).toContainText('2');
    await page.mouse.up();

    await expect(panel(page)).toBeVisible();
  });

  test('a poll redraws the pill in place, whether or not the row changed', async ({
    page,
  }) => {
    const state = await open(page, RUNNING, RUN);
    const handle = await page
      .getByRole('button', { name: /open pipeline/i })
      .first()
      .elementHandle();

    await poll(page);
    expect(await handle!.evaluate((n) => n.isConnected)).toBe(true);

    state.row = PASSED;
    state.checks = DONE;
    await poll(page);
    await expect(
      page.getByRole('button', { name: /^Passed.*open pipeline/i }),
    ).toBeVisible();
    // The same button now says Passed: it was redrawn in place, not replaced.
    expect(await handle!.evaluate((n) => n.isConnected)).toBe(true);
    expect(await handle!.evaluate((n) => n.textContent)).toContain('Passed');
  });

  test('a pill with keyboard focus keeps it when a poll redraws it', async ({
    page,
  }) => {
    const state = await open(page, RUNNING, RUN);
    await panel(page).getByRole('button', { name: /close/i }).click();
    const pill = page.getByRole('button', { name: /open pipeline/i }).first();
    await pill.focus();
    await expect(pill).toBeFocused();

    state.row = PASSED;
    state.checks = DONE;
    await poll(page);

    await expect(
      page.getByRole('button', { name: /^Passed.*open pipeline/i }),
    ).toBeFocused();
  });

  test('a failed live read says so and the next poll reads again', async ({
    page,
  }) => {
    const state = await open(page, RUNNING, RUN);
    state.status = 500;
    state.row = PASSED;
    await poll(page);
    await expect(
      panel(page).getByText(
        "Couldn't refresh these checks. They may be out of date.",
      ),
    ).toBeVisible();
    expect(state.requests).toBe(2);

    state.status = 200;
    state.checks = DONE;
    await poll(page);
    await expect(panel(page).getByRole('listitem').nth(1)).toContainText(
      'Passed',
    );
    expect(state.requests).toBe(3);
  });

  test('a poll that finds the same CI makes no request', async ({ page }) => {
    const state = await open(page, PASSED, DONE);
    await poll(page);
    await poll(page);
    expect(state.requests).toBe(1);
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [390, 1280]) {
      test(`has no axe violations after a live update, ${scheme} at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        const state = await open(page, RUNNING, RUN);
        state.row = PASSED;
        state.checks = DONE;
        await poll(page);
        await expect(panel(page).getByRole('listitem').nth(1)).toContainText(
          'Passed',
        );
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});

// The branch panel is the pull request board's dialog, so what a check carries
// is drawn the same way on both.
test.describe('main branches pipeline panel draws what a check carries', () => {
  test('a held check offers Approve on GitHub', async ({ page }) => {
    await open(
      page,
      RUNNING,
      [
        {
          name: 'deploy',
          state: 'awaiting_approval',
          url: 'https://example.com/r/9',
        },
      ],
      1,
    );

    await expect(
      panel(page).getByRole('link', {
        name: 'Approve on GitHub (opens in a new tab): deploy',
      }),
    ).toBeVisible();
  });

  test('required and advisory checks are grouped and a blocking failure is flagged', async ({
    page,
  }) => {
    await open(
      page,
      RUNNING,
      [
        {
          name: 'lint',
          state: 'failure',
          url: 'https://example.com/r/1',
          required: false,
        },
        {
          name: 'test',
          state: 'failure',
          url: 'https://example.com/r/2',
          required: true,
        },
      ],
      2,
    );

    await expect(
      panel(page).getByRole('heading', { name: 'Required (1)' }),
    ).toBeVisible();
    await expect(
      panel(page).getByRole('heading', { name: 'Advisory (1)' }),
    ).toBeVisible();
    await expect(panel(page).getByText('Blocking')).toHaveCount(1);
    await expect(panel(page).getByRole('listitem').first()).toContainText(
      'test',
    );
  });
});
