import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// Settings, Repositories: the per-repo controls moved here from the Webhooks
// page (#4028). Auto-update and Rebase bots are icon toggles with a fixed name
// and aria-pressed; Ignore stays a native select.

function repo(name: string, extra: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    fullName: `alrayyes/${name}`,
    hasWebhook: true,
    ignored: false,
    ignoredPRs: false,
    ignoredIssues: false,
    autoUpdateBranch: false,
    rebaseBots: false,
    ...extra,
  };
}

async function mockDashboard(page: Page, repos: Record<string, unknown>[]) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos,
      }),
    }),
  );
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const open = (page: Page) => page.goto('/settings.html#repositories');

test.describe('settings, repositories', () => {
  test('the #repositories hash opens the fifth group, last in the nav', async ({
    page,
  }) => {
    await mockDashboard(page, [repo('a')]);
    await open(page);
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: 'Repositories',
        exact: true,
      }),
    ).toBeVisible();
    const links = page
      .getByRole('navigation', { name: 'Settings groups' })
      .getByRole('link');
    await expect(links).toHaveCount(5);
    await expect(links.last()).toContainText('Repositories');
    await expect(links.last()).toContainText(
      'Auto-update, rebase bots, ignore',
    );
    await expect(links.nth(3)).not.toContainText(/webhook/i);
  });

  test('Auto-update is a pressed toggle with a fixed name', async ({
    page,
  }) => {
    await mockDashboard(page, [repo('a')]);
    const calls: { path: string; body: unknown }[] = [];
    await page.route('**/api/v1/repos/auto-update-branch/*', (route) => {
      calls.push({
        path: new URL(route.request().url()).pathname,
        body: route.request().postDataJSON(),
      });
      return route.fulfill({ status: 204 });
    });
    await open(page);

    const toggle = page.getByRole('button', {
      name: 'Auto-update on alrayyes/a',
    });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#repositories-status')).toContainText(
      'Auto-update-branch enabled for alrayyes/a',
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(calls).toEqual([
      {
        path: '/api/v1/repos/auto-update-branch/enable',
        body: { forge: 'github', fullName: 'alrayyes/a' },
      },
      {
        path: '/api/v1/repos/auto-update-branch/disable',
        body: { forge: 'github', fullName: 'alrayyes/a' },
      },
    ]);
  });

  test('a busy toggle keeps its name and says aria-busy', async ({ page }) => {
    await mockDashboard(page, [repo('a')]);
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    await page.route('**/api/v1/repos/auto-update-branch/*', async (route) => {
      await hold;
      await route.fulfill({ status: 204 });
    });
    await open(page);
    const toggle = page.getByRole('button', {
      name: 'Auto-update on alrayyes/a',
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-busy', 'true');
    release();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).not.toHaveAttribute('aria-busy', 'true');
  });

  test('a failed toggle shows the error and leaves the state', async ({
    page,
  }) => {
    await mockDashboard(page, [repo('a')]);
    await page.route('**/api/v1/repos/auto-update-branch/*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'could not save' }),
      }),
    );
    await open(page);
    const toggle = page.getByRole('button', {
      name: 'Auto-update on alrayyes/a',
    });
    await toggle.click();
    await expect(page.locator('#repositories-status')).toContainText(
      "Couldn't enable auto-update-branch for alrayyes/a: could not save",
    );
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  test('bulk auto-update asks first, then switches every repo that needs it', async ({
    page,
  }) => {
    await mockDashboard(page, [
      repo('a'),
      repo('b'),
      repo('c', { autoUpdateBranch: true }),
    ]);
    await page.route('**/api/v1/repos/auto-update-branch/*', (route) =>
      route.fulfill({ status: 204 }),
    );
    const prompts: string[] = [];
    page.on('dialog', (d) => {
      prompts.push(d.message());
      void d.dismiss();
    });
    await open(page);
    const bulk = page.getByRole('button', {
      name: 'Enable auto-update for 2 repos',
    });
    await bulk.click();
    expect(prompts).toEqual(['Enable auto-update-branch on 2 repos?']);
    await expect(
      page.getByRole('button', { name: 'Auto-update on alrayyes/a' }),
    ).toHaveAttribute('aria-pressed', 'false');

    page.removeAllListeners('dialog');
    page.on('dialog', (d) => void d.accept());
    await bulk.click();
    await expect(page.locator('#repositories-status')).toContainText(
      'Enabled auto-update-branch for all 2 repos.',
    );
    await expect(
      page.getByRole('button', { name: 'Disable auto-update for 3 repos' }),
    ).toBeVisible();
  });

  test('Ignore is a native select with the three scopes, and the repo moves to Ignored', async ({
    page,
  }) => {
    await mockDashboard(page, [repo('a'), repo('b')]);
    let body: unknown;
    await page.route('**/api/v1/repos/ignore', (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/v1/repos/unignore', (route) =>
      route.fulfill({ status: 204 }),
    );
    await open(page);

    const select = page.getByRole('combobox', { name: 'Ignore alrayyes/a' });
    await expect(select.locator('option:not([disabled])')).toHaveText([
      'Ignore PRs',
      'Ignore issues',
      'Ignore both',
    ]);
    await select.selectOption('issues');
    await expect(page.locator('#repositories-rows tr')).toHaveCount(1);
    expect(body).toEqual({
      forge: 'github',
      fullName: 'alrayyes/a',
      prs: false,
      issues: true,
    });
    await expect(page.locator('#repositories-rows tr')).toHaveCount(1);
    const disclosure = page.locator('#repositories-ignored');
    await expect(disclosure.locator('summary')).toContainText('Ignored (1)');
    await disclosure.locator('summary').click();
    await expect(disclosure).toContainText('(issues)');
    await expectNoAxeViolations(page);
    await disclosure.getByRole('button', { name: 'Un-ignore' }).click();
    await expect(page.locator('#repositories-rows tr')).toHaveCount(2);
    await expect(page.locator('#repositories-ignored')).toHaveCount(0);
  });

  for (const [scope, prs, issues] of [
    ['prs', true, false],
    ['issues', false, true],
    ['both', true, true],
  ] as const) {
    test(`Ignore ${scope} posts prs=${prs} and issues=${issues}`, async ({
      page,
    }) => {
      await mockDashboard(page, [repo('a')]);
      let body: unknown;
      await page.route('**/api/v1/repos/ignore', (route) => {
        body = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      });
      await open(page);
      await page
        .getByRole('combobox', { name: 'Ignore alrayyes/a' })
        .selectOption(scope);
      await expect(page.locator('#repositories-ignored')).toBeVisible();
      expect(body).toEqual({
        forge: 'github',
        fullName: 'alrayyes/a',
        prs,
        issues,
      });
    });
  }

  test('a busy ignore puts aria-busy on the select, not on its wrapper', async ({
    page,
  }) => {
    await mockDashboard(page, [repo('a')]);
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    await page.route('**/api/v1/repos/ignore', async (route) => {
      await hold;
      await route.fulfill({ status: 204 });
    });
    await open(page);
    const select = page.getByRole('combobox', { name: 'Ignore alrayyes/a' });
    await select.selectOption('prs');
    await expect(select).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.ignore-control[aria-busy]')).toHaveCount(0);
    release();
    await expect(page.locator('#repositories-ignored')).toBeVisible();
  });

  test('a failed ignore keeps the repo in the table', async ({ page }) => {
    await mockDashboard(page, [repo('a')]);
    await page.route('**/api/v1/repos/ignore', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'could not save' }),
      }),
    );
    await open(page);
    await page
      .getByRole('combobox', { name: 'Ignore alrayyes/a' })
      .selectOption('both');
    await expect(page.locator('#repositories-status')).toContainText(
      "Couldn't ignore alrayyes/a",
    );
    await expect(page.locator('#repositories-rows tr')).toHaveCount(1);
  });

  test('forge pills, search and Clear filters narrow the list', async ({
    page,
  }) => {
    await mockDashboard(page, [
      repo('alpha'),
      repo('beta'),
      repo('gamma', { forge: 'forgejo' }),
    ]);
    await open(page);
    const rows = page.locator('#repositories-rows tr');
    await expect(rows).toHaveCount(3);
    const clear = page.getByRole('button', { name: 'Clear filters' });
    await expect(clear).toHaveCount(0);

    await page.getByRole('button', { name: 'Forgejo' }).click();
    await expect(rows).toHaveCount(1);
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(rows).toHaveCount(3);

    await page.locator('#repositories-search').fill('BETA');
    await expect(rows).toHaveCount(1);
    await page.locator('#repositories-search').fill('nothing');
    await expect(page.locator('#repositories-no-results')).toHaveText(
      'No repos match these filters.',
    );
    await clear.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#repositories-search')).toBeFocused();
    await expect(rows).toHaveCount(3);
  });

  test('the empty state says nothing is tracked yet', async ({ page }) => {
    await mockDashboard(page, []);
    await open(page);
    await expect(page.locator('#repositories-empty')).toContainText(
      'Nothing tracked yet',
    );
  });

  test('a locked Rebase bots toggle is disabled and its note is linked', async ({
    page,
  }) => {
    await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
    await page.route('**/api/v1/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            forgeHealth('github', {
              dependabotCommandsBlocked: 'Dependabot ignores GitHub Apps',
            }),
          ],
          pullRequests: [],
          issues: [],
          repos: [repo('a')],
        }),
      }),
    );
    await open(page);
    const toggle = page.getByRole('button', {
      name: 'Rebase bots on alrayyes/a',
    });
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAccessibleDescription(
      /Dependabot needs a personal access token/,
    );
    await expectNoAxeViolations(page);
  });

  test('toggles are keyboard operable with a visible focus ring and tooltip', async ({
    page,
  }) => {
    await mockDashboard(page, [repo('a')]);
    await page.route('**/api/v1/repos/auto-update-branch/*', (route) =>
      route.fulfill({ status: 204 }),
    );
    await open(page);
    const toggle = page.getByRole('button', {
      name: 'Auto-update on alrayyes/a',
    });
    await page.keyboard.press('Tab');
    await toggle.focus();
    await page.keyboard.press('Tab'); // leave, then come back by keyboard
    await page.keyboard.press('Shift+Tab');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveCSS('outline-style', 'solid');
    await expect(toggle.locator('xpath=..')).toHaveAttribute(
      'data-tip',
      'Auto-update: off. Press to turn on',
    );
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('desktop: 32px controls, headers visible, no axe violations', async ({
    page,
  }) => {
    await mockDashboard(page, [repo('a', { rebaseBots: true }), repo('b')]);
    await open(page);
    for (const header of ['Auto-update', 'Rebase bots', 'Ignore']) {
      await expect(
        page.getByRole('columnheader', { name: new RegExp(header) }),
      ).toBeVisible();
    }
    const box = await page
      .getByRole('button', { name: 'Auto-update on alrayyes/a' })
      .boundingBox();
    expect(box?.width).toBe(32);
    expect(box?.height).toBe(32);
    await expectNoAxeViolations(page);
  });

  test('phone 390px: one-line cards, 44px controls, no sideways scroll, axe clean', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockDashboard(page, [
      repo('a', { rebaseBots: true }),
      repo('HilmarDouma/Meldpunt-incidenten.nl'.replace('/', '-')),
    ]);
    await open(page);
    const row = page.locator('#repositories-rows tr').first();
    const box = await row
      .getByRole('button', { name: /^Auto-update on/ })
      .boundingBox();
    expect(box?.width).toBe(44);
    expect(box?.height).toBe(44);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page);
  });

  test('dark mode passes axe too', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await mockDashboard(page, [repo('a', { autoUpdateBranch: true })]);
    await open(page);
    await expect(page.locator('#repositories-rows tr')).toHaveCount(1);
    await expectNoAxeViolations(page);
  });
});
