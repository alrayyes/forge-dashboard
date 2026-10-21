import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The Main branches pipeline panel reads its checks again only when the row's
// own CI changed in the page's poll: no request while nothing changes, none for
// a finished pipeline.

test.use({ storageState: SHARED_STORAGE_STATE_PATH });

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
    await panel(page).getByRole('link', { name: 'View run: test' }).focus();

    state.row = PASSED;
    state.checks = DONE;
    await poll(page);

    await expect(panel(page).getByRole('listitem')).toHaveCount(2);
    await expect(
      panel(page).getByRole('link', { name: 'View run: test' }),
    ).toBeFocused();
  });

  test('a redraw moves focus to the close button when its check is gone', async ({
    page,
  }) => {
    const state = await open(page, RUNNING, RUN);
    await panel(page).getByRole('link', { name: 'View run: test' }).focus();

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
