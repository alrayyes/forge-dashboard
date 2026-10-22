import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { createFirstRefreshGate, twoFrames } from './first-refresh-gate-helper';
import { test } from './server-fixture';
import { setTheme } from './theme-helper';

// #1224: one page with the CI status of every tracked repo's default branch,
// read from GET /api/main-branches (api/openapi.yaml: MainBranches).

const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60_000).toISOString();

function row(
  fullName: string,
  status:
    | 'failed'
    | 'running'
    | 'passed'
    | 'cancelled'
    | 'awaiting_approval'
    | 'none',
  overrides: Record<string, unknown> = {},
) {
  const forge = (overrides.forge as string | undefined) ?? 'github';
  const noCommit = status === 'none';
  return {
    forge,
    fullName,
    url: `https://example.com/${fullName}`,
    branch: 'main',
    status,
    commit: noCommit
      ? null
      : {
          sha: 'd98f3c2',
          subject: `fix: change in ${fullName}`,
          author: 'sre-dev',
          committedAt: minutesAgo(30),
        },
    failingJobs: status === 'failed' ? ['lint', 'e2e-playwright'] : [],
    finishedAt: status === 'running' || noCommit ? null : minutesAgo(12),
    durationSeconds: status === 'running' || noCommit ? null : 252,
    runUrl: `https://example.com/${fullName}/actions/runs/1`,
    stale: false,
    staleSince: null,
    ...overrides,
  };
}

function snapshot(branches: ReturnType<typeof row>[]) {
  const count = (s: string) => branches.filter((b) => b.status === s).length;
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      failed: count('failed'),
      passed: count('passed'),
      running: count('running'),
      cancelled: count('cancelled'),
      awaitingApproval: count('awaiting_approval'),
      none: count('none'),
      total: branches.length,
    },
    branches,
  };
}

const MIXED = [
  row('acme/ingress-controller', 'failed'),
  row('infra/homelab', 'failed', { forge: 'forgejo' }),
  row('alrayyes/forge-dashboard', 'running'),
  row('acme/auth-service', 'passed'),
  row('acme/billing', 'passed'),
  row('infra/wiki', 'none', { forge: 'forgejo', branch: 'master' }),
];

async function mock(
  page: Page,
  body: unknown | (() => unknown),
  // Answers the list with a 500 for as long as this says so.
  failing: () => boolean = () => false,
) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  // The list answer waits for the dashboard read of its document, so the page
  // never draws rows, swaps them for the first-refresh skeleton and draws
  // them again under a click (tests/first-refresh-gate-helper.ts).
  const gate = createFirstRefreshGate();
  page.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame())
      gate.newDocument();
  });
  // `*` so a query string still matches; the stream has its own route above.
  await page.route('**/api/dashboard*', async (route: Route) => {
    await gate.trackDashboard(() =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          readIntervalSeconds: 60,
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues: [],
          repos: [],
          hiddenDrafts: 0,
          firstRefreshDone: true,
        }),
      }),
    );
  });
  await page.route('**/api/main-branches', async (route: Route) => {
    await gate.wait();
    await twoFrames(page);
    if (failing()) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"boom"}',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(typeof body === 'function' ? body() : body),
    });
  });
}

// The jobs behind a row, from GET /api/main-branches/checks. Records each
// request so a test can say which repo the panel asked for.
const JOBS = [
  {
    name: 'lint',
    state: 'failure',
    url: 'https://example.com/acme/ingress-controller/actions/runs/1/jobs/1',
    durationSeconds: 65,
    failedStep: 'Run biome',
    excerpt: 'error: unused import',
  },
  {
    name: 'unit',
    state: 'success',
    url: 'https://example.com/acme/ingress-controller/actions/runs/1/jobs/2',
    durationSeconds: 42,
  },
  { name: 'e2e-playwright', state: 'skipped', url: '' },
];

async function mockChecks(
  page: Page,
  answer: { status?: number; body: unknown } = { body: { checks: JOBS } },
) {
  const asked: URL[] = [];
  await page.route('**/api/main-branches/checks*', (route: Route) => {
    asked.push(new URL(route.request().url()));
    return route.fulfill({
      status: answer.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(answer.body),
    });
  });

  return asked;
}

const dialog = (page: Page) => page.getByRole('dialog', { name: /pipeline/i });

const rows = (page: Page) => page.locator('[data-testid="main-branch-row"]');
const pill = (page: Page, name: RegExp | string) =>
  page.getByRole('button', { name });

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('Main branches page (#1224, #1279)', () => {
  test('the nav links to it, first, in the header and the phone tab bar', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.goto('/');
    const header = page.locator('.app-nav a[href="/"]');
    await expect(header).toHaveAttribute('aria-label', 'Branches');
    await expect(header).toHaveAttribute('aria-current', 'page');

    await page.setViewportSize({ width: 390, height: 844 });
    const tab = page.locator('.bottom-nav a[href="/"]');
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute('aria-current', 'page');
    // Every tab still fits inside the bar.
    const bar = await page.locator('.bottom-nav').boundingBox();
    const tabs = page.locator('.bottom-nav a');
    for (let i = 0; i < (await tabs.count()); i++) {
      const box = await tabs.nth(i).boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 999) + (box?.width ?? 999)).toBeLessThanOrEqual(
        (bar?.width ?? 0) + 0.5,
      );
    }
  });

  test('is hidden from a signed-out visitor', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    const anon = await context.newPage();
    await anon.goto('/');
    await expect(anon).toHaveURL(/login\.html/);
    await context.close();
  });

  test('lists one row per repo in the server order, with a summary and pill counts', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Main branches', level: 1 }),
    ).toHaveText('Main branches');
    await expect(rows(page)).toHaveCount(6);
    await expect(rows(page).locator('.mb-repo')).toHaveText([
      'acme/ingress-controller',
      'infra/homelab',
      'alrayyes/forge-dashboard',
      'acme/auth-service',
      'acme/billing',
      'infra/wiki',
    ]);
    // The nav and the pills carry the counts; no summary line repeats them.
    await expect(page.locator('#mb-summary')).toHaveCount(0);
    await expect(pill(page, /^All 6$/)).toBeVisible();
    await expect(pill(page, /^Failing 2$/)).toBeVisible();
    await expect(pill(page, /^Passing 2$/)).toBeVisible();
    await expect(pill(page, /^Running 1$/)).toBeVisible();
    await expect(pill(page, /^No pipeline 1$/)).toBeVisible();

    // Status is a word as well as an icon, and the row carries its commit.
    const first = rows(page).first();
    await expect(first.locator('.mb-status')).toContainText('Failed');
    await expect(first).toContainText('main');
    await expect(first).toContainText('d98f3c2');
    await expect(first).toContainText('fix: change in acme/ingress-controller');
    await expect(first).toContainText(
      'fix: change in acme/ingress-controller by sre-dev',
    );
    await expect(first).toContainText('lint');
    await expect(first).toContainText('e2e-playwright');
    await expect(first).toContainText('12 min ago (ran 4m 12s)');
    await expect(rows(page).nth(2).locator('.mb-status')).toContainText(
      'Running',
    );
    await expect(rows(page).nth(3).locator('.mb-status')).toContainText(
      'Passed',
    );
  });

  test('a pill lists only its status, and the filter is remembered across a reload', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.goto('/');
    await pill(page, /^Failing 2$/).click();
    await expect(pill(page, /^Failing 2$/)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).locator('.mb-status')).toHaveText([
      /Failed/,
      /Failed/,
    ]);

    await page.reload();
    await expect(pill(page, /^Failing 2$/)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(rows(page)).toHaveCount(2);

    await pill(page, /^Passing 2$/).click();
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).first()).toContainText('acme/auth-service');
    await pill(page, /^Running 1$/).click();
    await expect(rows(page)).toHaveCount(1);
    await pill(page, /^No pipeline 1$/).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('infra/wiki');
  });

  test('the forge pill is the same badge the pull requests page uses (#1364)', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.goto('/');
    try {
      for (const theme of ['light', 'dark']) {
        await setTheme(page, theme);
        await page.reload();
        await expect(rows(page)).toHaveCount(6);
        for (const [forge, repo, label] of [
          ['fj', 'infra/homelab', 'Forgejo'],
          ['gh', 'acme/auth-service', 'GitHub'],
        ]) {
          const badge = rows(page)
            .filter({ hasText: repo })
            .locator(`.forge-badge.${forge}`);
          await expect(badge).toHaveText(label);
          // Resolve each token through a probe element so the comparison is
          // against what the browser computes, in the theme under test.
          const got = await badge.evaluate((el, f) => {
            const probe = (
              token: string,
              prop: 'color' | 'backgroundColor',
            ) => {
              const d = document.createElement('div');
              d.style[prop] = `var(${token})`;
              document.body.appendChild(d);
              const v = getComputedStyle(d)[prop];
              d.remove();
              return v;
            };
            const cs = getComputedStyle(el);
            const dot = getComputedStyle(el.querySelector('.dot') as Element);
            return {
              bg: [cs.backgroundColor, probe(`--${f}-bg`, 'backgroundColor')],
              fg: [cs.color, probe(`--${f}`, 'color')],
              dot: [dot.backgroundColor, probe(`--${f}`, 'backgroundColor')],
            };
          }, forge);
          expect(got.bg[0], `${theme} ${forge} background`).toBe(got.bg[1]);
          expect(got.fg[0], `${theme} ${forge} text`).toBe(got.fg[1]);
          expect(got.dot[0], `${theme} ${forge} dot`).toBe(got.dot[1]);
        }
      }
    } finally {
      await setTheme(page, 'light');
    }
  });

  test('the forge toggle and the search narrow the list further, and are remembered', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.goto('/');
    await pill(page, /^Forgejo 2$/).click();
    await expect(rows(page)).toHaveCount(2);
    await pill(page, /^Failing \d/).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('infra/homelab');
    await pill(page, /^All 6$/).click();
    await pill(page, /^All forges/).click();
    await page.getByRole('searchbox', { name: /search/i }).fill('billing');
    await expect(rows(page)).toHaveCount(1);
    // The search reaches the server 500 ms after the last key. A reload before
    // that races the next page's read of the server copy (a product gap,
    // https://github.com/alrayyes/forge-dashboard/issues/1760), so wait.
    await expect
      .poll(async () =>
        JSON.stringify(
          await (await page.request.get('/api/settings/filter-state')).json(),
        ),
      )
      .toContain('billing');
    await page.reload();
    await expect(page.getByRole('searchbox', { name: /search/i })).toHaveValue(
      'billing',
    );
    await expect(rows(page)).toHaveCount(1);
    // Search also matches the commit author and a failing job.
    await page.getByRole('searchbox', { name: /search/i }).fill('e2e-play');
    await expect(rows(page)).toHaveCount(2);
  });

  test('the status pill opens the pipeline panel with the run jobs, and nothing navigates away', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    const asked = await mockChecks(page);
    await page.goto('/');
    const failed = rows(page).first();
    const pill = failed.getByRole('button', { name: 'Failed. Open pipeline' });
    await expect(pill).toHaveText('Failed');
    await expect(page.getByRole('button', { name: /re-run/i })).toHaveCount(0);

    await pill.click();
    const panel = dialog(page);
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    expect(asked.map((u) => u.search)).toEqual([
      '?forge=github&fullName=acme%2Fingress-controller',
    ]);
    await expect(panel).toContainText('acme/ingress-controller');
    const checks = panel.getByRole('listitem');
    await expect(checks).toHaveCount(3);
    await expect(checks.nth(0)).toContainText('lint');
    await expect(checks.nth(0)).toContainText('Failed');
    await expect(checks.nth(0)).toContainText('1m 5s');
    await expect(checks.nth(0)).toContainText('Failed step: Run biome');
    await expect(checks.nth(1)).toContainText('Passed');
    await expect(checks.nth(2)).toContainText('Skipped');
    // A skipped job, and one with no page, have no link.
    await expect(
      panel.getByRole('link', { name: /view run: lint/i }),
    ).toHaveCount(1);
    await expect(
      panel.getByRole('link', { name: /view run: e2e-playwright/i }),
    ).toHaveCount(0);
  });

  test('the panel links to the run on the forge in a new tab, and the failing jobs list is gone', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await mockChecks(page);
    await page.goto('/');
    const failed = rows(page).first();
    await expect(
      failed.getByRole('button', { name: /failing jobs/i }),
    ).toHaveCount(0);
    await failed
      .getByRole('button', { name: /^Failed\. Open pipeline/ })
      .click();

    const run = dialog(page).getByRole('link', { name: /open run on github/i });
    await expect(run).toHaveAttribute(
      'href',
      'https://example.com/acme/ingress-controller/actions/runs/1',
    );
    await expect(run).toHaveAttribute('target', '_blank');
    await expect(run).toHaveAttribute('rel', /noopener/);
    await expect(run).toHaveAccessibleName(/opens in a new tab/);
  });

  test('the repo link opens in a new tab and says so', async ({ page }) => {
    await mock(page, snapshot(MIXED));
    await page.goto('/');
    const link = rows(page).first().locator('a.mb-repo');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAccessibleName(/opens in a new tab/);
    // The name starts with the words on screen (WCAG 2.5.3).
    await expect(link).toHaveAccessibleName(/acme\/ingress-controller/);
  });

  test('every row with a pipeline has a pill button named for its status, and there is no View run', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.goto('/');
    await expect(rows(page)).toHaveCount(6);
    await expect(page.getByText('View run')).toHaveCount(0);
    await expect(page.locator('.mb-action, .mb-actions')).toHaveCount(0);
    for (const [n, word] of [
      [0, 'Failed'],
      [2, 'Running'],
      [3, 'Passed'],
    ] as const) {
      const control = rows(page).nth(n).locator('.ci-slot .ci-pill');
      await expect(control).toHaveAccessibleName(`${word}. Open pipeline`);
      expect(await control.evaluate((el) => el.tagName)).toBe('BUTTON');
    }
  });

  test('a failed job on a branch has the same Copy log button as a pull request', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mock(page, snapshot(MIXED));
    await mockChecks(page, {
      body: { checks: [{ ...JOBS[0], jobId: 11 }, JOBS[1]] },
    });
    await page.route('**/api/checks/log*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: 'whole log\n', truncated: false }),
      }),
    );
    await page.goto('/');
    await rows(page)
      .first()
      .getByRole('button', { name: /open pipeline/i })
      .click();

    await dialog(page).getByRole('button', { name: 'Copy log: lint' }).click();

    await expect(
      dialog(page).locator('.pipeline-check-copy-status'),
    ).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'whole log\n',
    );
    await expect(
      dialog(page).getByRole('button', { name: 'Copy log: unit' }),
    ).toHaveCount(0);
  });

  test('a row with a status but no run URL still opens the panel, without a run link', async ({
    page,
  }) => {
    await mock(
      page,
      snapshot([row('acme/failed-blank', 'failed', { runUrl: '' })]),
    );
    await mockChecks(page);
    await page.goto('/');
    await expect(page.locator('a[href=""]')).toHaveCount(0);
    await rows(page)
      .first()
      .getByRole('button', { name: /open pipeline/i })
      .click();
    await expect(dialog(page).getByRole('listitem')).toHaveCount(3);
    await expect(
      dialog(page).getByRole('link', { name: /open run on/i }),
    ).toHaveCount(0);
  });

  test('a failed read of the jobs says so, offers Retry and recovers', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    const asked = await mockChecks(page, {
      status: 403,
      body: { error: 'token cannot read checks' },
    });
    await page.goto('/');
    await rows(page)
      .first()
      .getByRole('button', { name: /open pipeline/i })
      .click();
    const alert = dialog(page).getByRole('alert');
    await expect(alert).toContainText('token cannot read checks');

    await page.unroute('**/api/main-branches/checks*');
    await mockChecks(page);
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(dialog(page).getByRole('listitem')).toHaveCount(3);
    expect(asked).toHaveLength(1);
  });

  test('two jobs with the same name and no page both list', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await mockChecks(page, {
      body: {
        checks: [
          { name: 'build', state: 'success', url: '' },
          { name: 'build', state: 'failure', url: '' },
        ],
      },
    });
    await page.goto('/');
    await rows(page)
      .first()
      .getByRole('button', { name: /open pipeline/i })
      .click();
    await expect(dialog(page).getByRole('listitem')).toHaveCount(2);
  });

  test('a rate-limited read shows the server sentence and Retry', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await mockChecks(page, {
      status: 429,
      body: { error: 'github rate limit exceeded, resets in 12 minutes' },
    });
    await page.goto('/');
    await rows(page)
      .first()
      .getByRole('button', { name: /open pipeline/i })
      .click();
    const alert = dialog(page).getByRole('alert');
    await expect(alert).toContainText('rate limit exceeded, resets in 12');
    await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('an answer that arrives after the panel moved on is not drawn', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    // The first row's answer is held back until the second row's has drawn.
    let releaseSlow: () => void = () => {};
    const slowHeld = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    await page.route('**/api/main-branches/checks*', async (route: Route) => {
      const slow = new URL(route.request().url()).searchParams
        .get('fullName')
        ?.includes('ingress');
      if (slow) await slowHeld;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checks: [
            {
              name: slow ? 'from-the-first-row' : 'from-the-second-row',
              state: 'success',
              url: '',
            },
          ],
        }),
      });
    });
    await page.goto('/');
    await rows(page)
      .first()
      .getByRole('button', { name: /open pipeline/i })
      .click();
    await dialog(page).getByRole('button', { name: /close/i }).click();
    await expect(dialog(page)).toBeHidden();

    await rows(page)
      .nth(2)
      .getByRole('button', { name: /open pipeline/i })
      .click();
    await expect(dialog(page)).toContainText('from-the-second-row');

    const late = page.waitForResponse((r) =>
      r.url().includes('fullName=acme%2Fingress-controller'),
    );
    releaseSlow();
    await late;
    // Two frames after the late answer, when a draw would have happened.
    await twoFrames(page);
    await expect(dialog(page)).toContainText('from-the-second-row');
    await expect(dialog(page)).not.toContainText('from-the-first-row');
  });

  test('a branch with no jobs says so in the panel', async ({ page }) => {
    await mock(page, snapshot(MIXED));
    await mockChecks(page, { body: { checks: [] } });
    await page.goto('/');
    await rows(page)
      .first()
      .getByRole('button', { name: /open pipeline/i })
      .click();
    await expect(dialog(page)).toContainText('No jobs were found');
  });

  test('the pill opens from the keyboard, Escape closes the panel and focus returns to the pill', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await mockChecks(page);
    await page.goto('/');
    const pill = rows(page).first().locator('.ci-slot .ci-pill');
    await pill.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(pill).toBeFocused();
  });

  // A browser that does not focus a button on click (Safari) leaves nothing
  // for the dialog to restore, so the panel hands focus back itself. A click
  // dispatched from script focuses nothing, which is the same situation.
  test('focus returns to the pill even when the click never focused it', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await mockChecks(page);
    await page.goto('/');
    const pill = rows(page).first().locator('.ci-slot .ci-pill');
    await pill.evaluate((el) => (el as HTMLElement).click());
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(pill).toBeFocused();
  });

  test('the close button returns focus to the pill too', async ({ page }) => {
    await mock(page, snapshot(MIXED));
    await mockChecks(page);
    await page.goto('/');
    const pill = rows(page).nth(2).locator('.ci-slot .ci-pill');
    await pill.click();
    await dialog(page).getByRole('button', { name: /close/i }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(pill).toBeFocused();
  });

  test('the status pill is larger than the pull request board pill: 32px on desktop, 44px on a phone', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const pill = rows(page).first().locator('.ci-slot .ci-pill');
    await expect(pill).toBeVisible();
    expect((await pill.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(32);
    for (const n of [0, 2, 3]) {
      const box = await rows(page)
        .nth(n)
        .locator('.ci-slot .ci-pill')
        .boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(32);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await pill.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('a repo with no pipeline says no run was found and has no commit to show', async ({
    page,
  }) => {
    await mock(
      page,
      snapshot([row('infra/wiki', 'none', { forge: 'forgejo' })]),
    );
    await page.goto('/');
    const only = rows(page).first();
    await expect(only.locator('.mb-status')).toContainText('No pipeline');
    await expect(
      only.getByRole('button', { name: /open pipeline/i }),
    ).toHaveCount(0);
    await expect(only.locator('.mb-status a, .mb-status button')).toHaveCount(
      0,
    );
    await expect(only).toContainText('No run was found');
  });

  test('stale rows sit under one banner and offer nothing to write', async ({
    page,
  }) => {
    const stale = { stale: true, staleSince: minutesAgo(11) };
    await mock(
      page,
      snapshot([
        row('acme/a', 'failed', stale),
        row('acme/b', 'passed', stale),
        row('infra/c', 'passed', { forge: 'forgejo' }),
      ]),
    );
    await page.goto('/');
    await expect(page.locator('[data-testid="stale-banner"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="stale-banner"]')).toContainText(
      /last known status/i,
    );
    await expect(rows(page).locator('.mb-stale')).toHaveText([
      'stale',
      'stale',
    ]);
    await expect(page.getByRole('button', { name: /re-run/i })).toHaveCount(0);
  });

  test('says so when every default branch is passing', async ({ page }) => {
    await mock(
      page,
      snapshot([row('acme/a', 'passed'), row('infra/b', 'passed')]),
    );
    await page.goto('/');
    await expect(page.locator('[data-testid="all-green"]')).toContainText(
      /every default branch is passing/i,
    );
    await expect(rows(page)).toHaveCount(2);
  });

  test('says nothing matches, and offers to reset the filters', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.goto('/');
    await page.getByRole('searchbox', { name: /search/i }).fill('zzz-nothing');
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="no-match"]')).toContainText(
      /nothing matches/i,
    );
    await page.getByRole('button', { name: /reset filters/i }).click();
    await expect(rows(page)).toHaveCount(6);
    await expect(page.getByRole('searchbox', { name: /search/i })).toHaveValue(
      '',
    );
  });

  test('says there are no tracked repositories when the read is empty', async ({
    page,
  }) => {
    await mock(page, snapshot([]));
    await page.goto('/');
    await expect(page.locator('[data-testid="no-repos"]')).toBeVisible();
  });

  test('a failed read shows an error with a retry that recovers', async ({
    page,
  }) => {
    let fail = true;
    // Behind the same dashboard gate as every other test.
    await mock(page, snapshot(MIXED), () => fail);
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText(/couldn't load/i);
    fail = false;
    await page.getByRole('button', { name: /retry/i }).click();
    await expect(rows(page)).toHaveCount(6);
  });

  test('has no axe violations in light and dark, desktop and 390px, and no horizontal scroll', async ({
    page,
  }) => {
    const stale = { stale: true, staleSince: minutesAgo(11) };
    await mock(page, snapshot([...MIXED, row('acme/stale', 'failed', stale)]));
    await page.goto('/');
    await expect(rows(page)).toHaveCount(7);

    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      await page.reload();
      await expect(rows(page)).toHaveCount(7);
      for (const size of [
        { width: 1280, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        expect(
          (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
            .violations,
        ).toEqual([]);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      }
    }
    await setTheme(page, 'light');
  });

  test('the open pipeline panel has no axe violations in light and dark, desktop and 390px', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await mockChecks(page);
    await page.goto('/');
    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      await page.reload();
      await rows(page)
        .first()
        .getByRole('button', { name: /open pipeline/i })
        .click();
      await expect(dialog(page).getByRole('listitem')).toHaveCount(3);
      for (const size of [
        { width: 1280, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        expect(
          (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
            .violations,
        ).toEqual([]);
        const box = await dialog(page).boundingBox();
        expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(
          size.width,
        );
      }
      await page.keyboard.press('Escape');
    }
    await setTheme(page, 'light');
  });

  test('on a phone each row is a card with a primary action at least 44px tall', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const failed = rows(page).first();
    await expect(failed).toBeVisible();
    for (const control of [
      failed.locator('.ci-slot .ci-pill'),
      pill(page, /^Failing \d/),
      pill(page, /^All 6$/),
    ]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  // #1563 slice 4: the row's CI status is a state (running) or an outcome
  // (failed, passed) in one fixed slot with the pull request row's glyphs and
  // colours. "No pipeline" is neither, so it is a quiet outlined note.
  // https://github.com/alrayyes/forge-dashboard/issues/1563
  const slotOf = (page: Page, n: number) =>
    rows(page).nth(n).locator('.ci-slot');

  test('failed, running and passed share one slot box, with the pull request row glyphs', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await expect(rows(page)).toHaveCount(6);
    const cases = [
      { n: 0, word: 'Failed', cls: 'failure', glyph: 'cross' },
      { n: 2, word: 'Running', cls: 'pending', glyph: 'arc' },
      { n: 3, word: 'Passed', cls: 'success', glyph: 'check' },
    ];
    const slots = [];
    const pills = [];
    for (const c of cases) {
      const pill = slotOf(page, c.n).locator('.ci-pill');
      await expect(pill).toHaveText(c.word);
      await expect(pill).toHaveClass(new RegExp(`\\b${c.cls}\\b`));
      await expect(pill.locator(`svg[data-glyph="${c.glyph}"]`)).toBeAttached();
      await expect(pill.locator('.dot')).toHaveCount(0);
      slots.push(await slotOf(page, c.n).boundingBox());
      pills.push(await pill.boundingBox());
    }
    // Same size in every state; the slot sits top right of its card.
    expect(new Set(slots.map((b) => `${b?.width}x${b?.height}`)).size).toBe(1);
    expect(new Set(pills.map((b) => `${b?.width}x${b?.height}`)).size).toBe(1);
    const card = await rows(page).first().boundingBox();
    expect((slots[0]?.x ?? 0) + (slots[0]?.width ?? 0)).toBeGreaterThan(
      (card?.x ?? 0) + (card?.width ?? 0) - 24,
    );
    expect(slots[0]?.y ?? 0).toBeLessThan((card?.y ?? 0) + 24);
  });

  test('a cancelled branch says Cancelled in words, links its run, and is not counted as failing (#1950)', async ({
    page,
  }) => {
    await mock(
      page,
      snapshot([
        row('acme/superseded', 'cancelled'),
        row('acme/broken', 'failed'),
      ]),
    );
    await page.goto('/');
    await expect(rows(page)).toHaveCount(2);

    const cancelled = rows(page).filter({ hasText: 'acme/superseded' });
    const control = cancelled.getByRole('button', {
      name: /Cancelled\. Open pipeline/,
    });
    await expect(control).toHaveText('Cancelled');
    await expect(control.locator('svg[data-glyph="stop"]')).toBeAttached();

    await expect(pill(page, /^Failing \d/)).toContainText('1');
    await expect(pill(page, /^Cancelled \d/)).toContainText('1');
    await pill(page, /^Cancelled \d/).click();
    await expect(rows(page)).toHaveCount(1);

    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      await page.reload();
      await expect(rows(page)).toHaveCount(1);
      expect(
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
      ).toEqual([]);
    }
    await setTheme(page, 'light');
  });

  test('a branch whose runs are held for approval says so in words, with the pause glyph, and is filterable (#2024)', async ({
    page,
  }) => {
    await mock(
      page,
      snapshot([
        row('acme/held', 'awaiting_approval'),
        row('acme/ok', 'passed'),
        row('acme/broken', 'failed'),
      ]),
    );
    await page.goto('/');
    await expect(rows(page)).toHaveCount(3);

    const held = rows(page).filter({ hasText: 'acme/held' });
    const control = held.getByRole('button', {
      name: /Waiting for approval\. Open pipeline/,
    });
    await expect(control).toHaveText('Waiting for approval');
    await expect(control).toHaveClass(/\bawaiting\b/);
    await expect(control.locator('svg[data-glyph="pause"]')).toBeAttached();

    await expect(pill(page, /^Waiting for approval \d/)).toContainText('1');
    await expect(pill(page, /^Failing \d/)).toContainText('1');
    await pill(page, /^Waiting for approval \d/).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('acme/held');

    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      await page.reload();
      await expect(rows(page)).toHaveCount(1);
      expect(
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
      ).toEqual([]);
    }
    await setTheme(page, 'light');
  });

  test('the repo link carries the full owner/name as hover text (#1961)', async ({
    page,
  }) => {
    await mock(page, snapshot([row('alrayyes/forge-dashboard', 'passed')]));
    await page.goto('/');
    await expect(rows(page).locator('.mb-repo')).toHaveAttribute(
      'title',
      'alrayyes/forge-dashboard',
    );
  });

  test('No pipeline is a quiet outlined note, neither a state nor an outcome', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.goto('/');
    const note = slotOf(page, 5).locator('.attr-chip');
    await expect(note).toHaveText('No pipeline');
    await expect(slotOf(page, 5).locator('.ci-pill')).toHaveCount(0);
    const style = await note.evaluate((el) => {
      const s = getComputedStyle(el);
      const probe = document.createElement('span');
      const states = ['--good', '--warning', '--critical', '--queued'].map(
        (t) => {
          probe.style.color = `var(${t})`;
          document.body.appendChild(probe);
          const v = getComputedStyle(probe).color;
          probe.remove();
          return v;
        },
      );
      return {
        background: s.backgroundColor,
        border: s.borderTopWidth,
        animation: s.animationName,
        isState: states.includes(s.color),
      };
    });
    // Right edge on the slot's right edge, as tall as the pills.
    const slotBox = await slotOf(page, 5).boundingBox();
    const noteBox = await note.boundingBox();
    const pillBox = await slotOf(page, 0).locator('.ci-pill').boundingBox();
    expect((noteBox?.x ?? 0) + (noteBox?.width ?? 0)).toBeCloseTo(
      (slotBox?.x ?? 0) + (slotBox?.width ?? 0),
      0,
    );
    expect(noteBox?.height).toBe(pillBox?.height);
    expect(style).toEqual({
      background: 'rgba(0, 0, 0, 0)',
      border: '1px',
      animation: 'none',
      isState: false,
    });
  });

  test('the running glyph keeps still under reduced motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mock(page, snapshot(MIXED));
    await page.goto('/');
    const pill = slotOf(page, 2).locator('.ci-pill');
    await expect(pill.locator('svg[data-glyph="arc"]')).toBeHidden();
    await expect(pill.locator('svg[data-glyph="clock"]')).toBeVisible();
    const playing = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a.playState === 'running')
        .map((a) => a.id),
    );
    expect(playing).toEqual([]);
  });

  for (const theme of ['light', 'dark']) {
    test(`the slot at 360px has no overflow and passes axe in ${theme} mode`, async ({
      page,
    }) => {
      await mock(page, snapshot(MIXED));
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto('/');
      await setTheme(page, theme);
      await page.reload();
      await expect(rows(page)).toHaveCount(6);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const card = await rows(page).first().boundingBox();
      const slot = await slotOf(page, 0).boundingBox();
      expect((slot?.x ?? 0) + (slot?.width ?? 0)).toBeLessThanOrEqual(
        (card?.x ?? 0) + (card?.width ?? 0) + 1,
      );
      expect(slot?.y ?? 0).toBeLessThan((card?.y ?? 0) + 24);
      const results = await new AxeBuilder({ page })
        .withTags([...AXE_TAGS, 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
      await setTheme(page, 'light');
    });
  }
});
