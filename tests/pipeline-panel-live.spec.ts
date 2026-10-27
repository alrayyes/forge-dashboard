import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { checkLinkName } from './check-link-name-helper';
import { pushChecks, serveChecks } from './checks-feed-helper';
import { installFakeStream } from './fake-stream-helper';
import { test } from './server-fixture';

// The pipeline panel draws the job lists the server sends on the dashboard
// stream, and holds the newest while live updates are paused. Whether the
// server sends one (only when the pull request's CI changed) is the Go tests'
// to prove. The page's EventSource is stubbed so the test decides when a
// snapshot and its list arrive.

declare global {
  interface Window {
    __push: (data: unknown) => void;
    __said: string[];
  }
}

type Counts = {
  passed: number;
  running: number;
  waiting: number;
  failed: number;
};

function pr(ci: string, checks: Counts, forge = 'github') {
  return {
    forge,
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Add structured logging',
    url: 'https://example.com/42',
    author: 'claude',
    draft: false,
    ci,
    checks,
    labels: [],
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    mergeStatus: 'blocked',
    status: 'blocked',
    kind: 'regular',
    behind: false,
    allowedActions: [] as { action: string }[],
  };
}

function snapshot(item: ReturnType<typeof pr>) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: [item],
    issues: [],
  };
}

const RUNNING = pr('pending', { passed: 1, running: 1, waiting: 0, failed: 0 });
const PASSED = pr('success', { passed: 2, running: 0, waiting: 0, failed: 0 });
const RUNNING_FORGEJO = pr(
  'pending',
  { passed: 1, running: 1, waiting: 0, failed: 0 },
  'forgejo',
);
const PASSED_FORGEJO = pr(
  'success',
  { passed: 2, running: 0, waiting: 0, failed: 0 },
  'forgejo',
);

const RUN = [
  { name: 'build', state: 'success', url: 'https://example.com/r/1' },
  { name: 'test', state: 'running', url: 'https://example.com/r/2' },
];
const DONE = [
  { name: 'build', state: 'success', url: 'https://example.com/r/1' },
  { name: 'test', state: 'success', url: 'https://example.com/r/2' },
];

async function stubStream(page: Page) {
  await installFakeStream(page);
  await page.addInitScript(() => {
    window.__push = (data) =>
      (
        window as unknown as { __streamPush: (m: unknown) => void }
      ).__streamPush(data);
  });
}

// Serves the first snapshot and whatever checks `state.checks` holds, and
// sends a failure instead while `state.status` is not 200.
async function open(
  page: Page,
  first: ReturnType<typeof pr>,
  checks: unknown[],
  count = 2,
) {
  const state = { checks, status: 200 };
  await stubStream(page);
  await serveChecks(page, () => state.checks);
  await page.route('**/api/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(first)),
    }),
  );
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: 'Open pipeline' })
    .click();
  await expect(page.locator('#pipeline-dialog .pipeline-check')).toHaveCount(
    count,
  );

  return state;
}

async function push(page: Page, item: ReturnType<typeof pr>) {
  await page.evaluate((data) => window.__push(data), snapshot(item));
}

// A snapshot that moves the pull request's CI, with the list the server then
// sends for it, or why it has none.
async function update(
  page: Page,
  state: { checks: unknown[]; status: number },
  item: ReturnType<typeof pr>,
) {
  await push(page, item);
  await pushChecks(
    page,
    {
      kind: 'pull_request',
      forge: item.forge,
      fullName: item.repo,
      number: item.number,
    },
    state.status === 200 ? state.checks : { error: 'forge unreachable' },
  );
}

const dialog = (page: Page) => page.locator('#pipeline-dialog');

test.describe('pipeline panel updates live', () => {
  test('a check going from queued to running shows View run at once on Forgejo, with no reload', async ({
    page,
  }) => {
    const QUEUED = pr(
      'pending',
      {
        passed: 1,
        running: 0,
        waiting: 1,
        failed: 0,
      },
      'forgejo',
    );
    const before = [
      { name: 'build', state: 'success', url: 'https://example.com/r/1' },
      {
        name: 'test',
        state: 'queued',
        url: 'https://example.com/r/2',
        jobId: 2,
      },
    ];
    const state = await open(page, QUEUED, before);
    const view = dialog(page).getByRole('button', { name: 'View run: test' });
    await expect(view).toHaveCount(0);
    await expect(
      dialog(page).getByRole('link', {
        name: checkLinkName('Open on Forgejo', 'test'),
      }),
    ).toBeVisible();

    state.checks = [before[0], { ...before[1], state: 'running' }];
    await update(
      page,
      state,
      pr(
        'pending',
        { passed: 1, running: 1, waiting: 0, failed: 0 },
        'forgejo',
      ),
    );

    await expect(view).toBeVisible();
    await expect(
      dialog(page).getByRole('link', {
        name: checkLinkName('Open on Forgejo', 'test'),
      }),
    ).toHaveCount(1);
  });

  test('a check finishing changes its pill in place, announced once', async ({
    page,
  }) => {
    const state = await open(page, RUNNING, RUN);
    const items = dialog(page).locator('.pipeline-check');
    await expect(items.nth(1)).toContainText('Running');

    state.checks = DONE;
    await update(page, state, PASSED);

    await expect(items.nth(1)).toContainText('Passed');
    await expect(items.nth(0)).toContainText('build');
    await expect(items).toHaveCount(2);
    await expect(dialog(page).locator('.pipeline-live-status')).toHaveText(
      'Checks updated: test is now Passed.',
    );
  });

  test('a failed live read says so and the next list replaces it', async ({
    page,
  }) => {
    const state = await open(page, RUNNING, RUN);
    state.checks = DONE;
    state.status = 500;
    await update(page, state, PASSED);

    await expect(dialog(page).locator('.pipeline-paused-note')).toHaveText(
      "Couldn't refresh these checks. They may be out of date.",
    );
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Running',
    );

    state.status = 200;
    await update(page, state, PASSED);

    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Passed',
    );
    await expect(dialog(page).locator('.pipeline-paused-note')).toBeHidden();
  });

  test('two changes that read the same are each announced', async ({
    page,
  }) => {
    const pair = (state: string) => [
      { name: 'a', state, url: 'https://example.com/r/a' },
      { name: 'b', state, url: 'https://example.com/r/b' },
    ];
    const state = await open(page, RUNNING, pair('running'));
    // A screen reader speaks a live region when its text changes, so an
    // identical line has to come after the region was emptied.
    await dialog(page).evaluate((node) => {
      const region = node.querySelector('.pipeline-live-status');
      const seen: string[] = [];
      window.__said = seen;
      new MutationObserver(() => seen.push(region?.textContent ?? '')).observe(
        region as Element,
        { childList: true, characterData: true, subtree: true },
      );
    });
    const line = 'Checks updated: 2 checks changed.';
    const spoken = () =>
      page.evaluate(() => window.__said.filter((text) => text !== ''));

    state.checks = pair('success');
    await update(page, state, PASSED);
    await expect.poll(spoken).toEqual([line]);
    state.checks = pair('running');
    await update(page, state, RUNNING);

    await expect.poll(spoken).toEqual([line, line]);
    const all = await page.evaluate(() => window.__said);
    expect(all.slice(all.indexOf(line), all.lastIndexOf(line))).toContain('');
  });

  test('a redraw keeps focus on the same check when an earlier one is gone', async ({
    page,
  }) => {
    const three = [
      { name: 'lint', state: 'running', url: 'https://example.com/r/0' },
      { name: 'build', state: 'success', url: 'https://example.com/r/1' },
      { name: 'test', state: 'running', url: 'https://example.com/r/2' },
    ];
    const state = await open(page, RUNNING_FORGEJO, three, 3);
    const link = dialog(page).getByRole('link', {
      name: checkLinkName('View run', 'test'),
    });
    await link.focus();

    state.checks = [
      { name: 'build', state: 'success', url: 'https://example.com/r/1' },
      { name: 'test', state: 'success', url: 'https://example.com/r/2' },
    ];
    await update(page, state, PASSED_FORGEJO);

    await expect(dialog(page).locator('.pipeline-check')).toHaveCount(2);
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Passed',
    );
    await expect(
      dialog(page).getByRole('link', {
        name: checkLinkName('View run', 'test'),
      }),
    ).toBeFocused();
  });

  test('a redraw moves focus to the close button when its check is gone', async ({
    page,
  }) => {
    const state = await open(page, RUNNING_FORGEJO, RUN);
    await dialog(page)
      .getByRole('link', { name: checkLinkName('View run', 'test') })
      .focus();

    state.checks = [
      { name: 'build', state: 'failure', url: 'https://example.com/r/1' },
    ];
    await update(
      page,
      state,
      pr(
        'failure',
        { passed: 0, running: 0, waiting: 0, failed: 1 },
        'forgejo',
      ),
    );

    await expect(dialog(page).locator('.pipeline-check')).toHaveCount(1);
    await expect(
      dialog(page).getByRole('button', { name: /close/i }),
    ).toBeFocused();
  });

  test('a rerun that starts redraws the finished panel', async ({ page }) => {
    const state = await open(page, PASSED, DONE);
    state.checks = RUN;
    await update(page, state, RUNNING);
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Running',
    );
  });

  test('the order stays put when a check starts to fail', async ({ page }) => {
    const state = await open(page, RUNNING, RUN);
    state.checks = [
      { name: 'test', state: 'failure', url: 'https://example.com/r/2' },
      { name: 'build', state: 'success', url: 'https://example.com/r/1' },
    ];
    await update(
      page,
      state,
      pr('failure', { passed: 1, running: 0, waiting: 0, failed: 1 }),
    );
    const names = dialog(page).locator('.pipeline-check-name');
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Failed',
    );
    await expect(names).toHaveText(['build', 'test']);
  });

  test('a blocking failure listed first stays first through a live redraw', async ({
    page,
  }) => {
    const req = (name: string, state: string) => ({
      name,
      state,
      required: true,
      url: `https://example.com/r/${name}`,
    });
    const state = await open(page, RUNNING, [
      req('build', 'running'),
      req('lint', 'failure'),
    ]);
    const names = dialog(page).locator('.pipeline-check-name');
    await expect(names).toHaveText(['lint', 'build']);
    state.checks = [req('build', 'success'), req('lint', 'failure')];
    await update(
      page,
      state,
      pr('failure', { passed: 1, running: 0, waiting: 0, failed: 1 }),
    );
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Passed',
    );
    await expect(names).toHaveText(['lint', 'build']);
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [390, 1280]) {
      test(`has no axe violations after a live update, ${scheme} at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        const state = await open(page, RUNNING, RUN);
        state.checks = DONE;
        await update(page, state, PASSED);
        await expect(
          dialog(page).locator('.pipeline-check').nth(1),
        ).toContainText('Passed');
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});

test.describe('pipeline panel with live updates paused', () => {
  test('holds the new list, says so, passes axe, and draws it on resume', async ({
    page,
  }: {
    page: Page;
  }) => {
    await stubStream(page);
    const state = { status: 200, checks: RUN as unknown[] };
    await serveChecks(page, () => state.checks);
    await page.route('**/api/dashboard', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(RUNNING)),
      }),
    );
    await page.goto('/pull-requests.html');
    await page.getByRole('button', { name: 'Pause live updates' }).click();
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    await expect(dialog(page).locator('.pipeline-check')).toHaveCount(2);
    await expect(dialog(page).locator('.pipeline-paused-note')).toBeHidden();

    state.checks = DONE;
    await update(page, state, PASSED);

    await expect(dialog(page).locator('.pipeline-paused-note')).toHaveText(
      'Live updates are paused. These checks may be out of date.',
    );
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Running',
    );
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    // Turning updates back on draws the list that waited. The button sits
    // behind the modal panel, so the click is dispatched.
    await page
      .getByRole('button', { name: 'Pause live updates' })
      .dispatchEvent('click');
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Passed',
    );
    await expect(dialog(page).locator('.pipeline-paused-note')).toBeHidden();
  });
});

// A failed Rerun failed checks puts a Copy button beside the failure. A live
// redraw draws the control again and keeps the keyboard on the same button.
test.describe('pipeline panel rerun control through a live redraw', () => {
  test('a focused Copy button keeps focus', async ({ page }) => {
    const failing = {
      ...pr('failure', { passed: 0, running: 0, waiting: 0, failed: 1 }),
      allowedActions: [{ action: 'rerun_checks' }],
    };
    const state = await open(
      page,
      failing,
      [
        {
          name: 'test',
          state: 'failure',
          url: 'https://example.com/r/2',
          required: true,
        },
      ],
      1,
    );
    await page.route('**/api/pull-requests/rerun-checks', (route: Route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'refused' }),
      }),
    );
    await dialog(page)
      .getByRole('button', { name: 'Rerun failed checks' })
      .click();
    const copy = dialog(page).getByRole('button', {
      name: 'Copy error details',
    });
    await copy.focus();
    await expect(copy).toBeFocused();

    state.checks = [
      {
        name: 'test',
        state: 'failure',
        url: 'https://example.com/r/2',
        required: true,
      },
      { name: 'extra', state: 'failure', url: 'https://example.com/r/3' },
    ];
    await update(page, state, {
      ...failing,
      checks: { passed: 0, running: 0, waiting: 0, failed: 2 },
    });

    await expect(dialog(page).locator('.pipeline-check')).toHaveCount(2);
    await expect(copy).toBeFocused();
  });
});
