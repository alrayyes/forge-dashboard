import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';
import { setTheme } from './theme-helper';

// #1224: one page with the CI status of every tracked repo's default branch,
// read from GET /api/main-branches (api/openapi.yaml: MainBranches).

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `main-branches-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Main Branches');
}

const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60_000).toISOString();

function row(
  fullName: string,
  status: 'failed' | 'running' | 'passed' | 'none',
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

async function mock(page: Page, body: unknown | (() => unknown)) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(typeof body === 'function' ? body() : body),
    }),
  );
}

const rows = (page: Page) => page.locator('[data-testid="main-branch-row"]');
const pill = (page: Page, name: RegExp | string) =>
  page.getByRole('button', { name });

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('Main branches page (#1224, #1279)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

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
          const probe = (token: string, prop: 'color' | 'backgroundColor') => {
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
    await page.reload();
    await expect(page.getByRole('searchbox', { name: /search/i })).toHaveValue(
      'billing',
    );
    await expect(rows(page)).toHaveCount(1);
    // Search also matches the commit author and a failing job.
    await page.getByRole('searchbox', { name: /search/i }).fill('e2e-play');
    await expect(rows(page)).toHaveCount(2);
  });

  test('a failed row links to its run, expands to its failing jobs and offers no re-run', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.goto('/');
    const failed = rows(page).first();
    const link = failed.getByRole('link', { name: /View run/ });
    await expect(link).toHaveAttribute(
      'href',
      'https://example.com/acme/ingress-controller/actions/runs/1',
    );
    await expect(page.getByRole('button', { name: /re-run/i })).toHaveCount(0);

    const toggle = failed.getByRole('button', { name: /failing jobs/i });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(
      failed.getByRole('list', { name: /failing jobs/i }),
    ).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(
      failed.getByRole('list', { name: /failing jobs/i }).getByRole('listitem'),
    ).toHaveText(['lint', 'e2e-playwright']);
    // A passing row has nothing to expand.
    await expect(
      rows(page)
        .nth(3)
        .getByRole('button', { name: /failing jobs/i }),
    ).toHaveCount(0);
  });

  test('the repo and View run links open in a new tab and say so (#1266)', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.goto('/');
    const failed = rows(page).first();

    for (const link of [
      failed.locator('a.mb-repo'),
      failed.getByRole('link', { name: /View run/ }),
    ]) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
      await expect(link).toHaveAccessibleName(/opens in a new tab/);
    }
    // The name still carries the words on screen (WCAG 2.5.3).
    await expect(failed.locator('a.mb-repo')).toHaveAccessibleName(
      /acme\/ingress-controller/,
    );
    await expect(
      failed.getByRole('link', { name: /View run/ }),
    ).toHaveAccessibleName(/^View run/);
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
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
    await page.route('**/api/main-branches', (route: Route) =>
      fail
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: '{"error":"boom"}',
          })
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(snapshot(MIXED)),
          }),
    );
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
    await rows(page)
      .first()
      .getByRole('button', { name: /failing jobs/i })
      .click();

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

  test('on a phone each row is a card with a primary action at least 44px tall', async ({
    page,
  }) => {
    await mock(page, snapshot(MIXED));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const failed = rows(page).first();
    await expect(failed).toBeVisible();
    for (const control of [
      failed.getByRole('link', { name: /View run/ }),
      failed.getByRole('button', { name: /failing jobs/i }),
      pill(page, /^Failing \d/),
      pill(page, /^All 6$/),
    ]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});
