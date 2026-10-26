import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

const LOCK_TEXT =
  'Dependabot needs a personal access token when a GitHub App is connected.';

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

function mockDashboard(
  page: Page,
  repos: Record<string, unknown>[],
  forges: Record<string, unknown>[] = [],
) {
  void page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges,
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

test.describe('rebase bots setting on the webhooks page', () => {
  test('switching a repo on and off calls the endpoints and says so', async ({
    page,
  }) => {
    await mockDashboard(page, [repo('a')]);
    const bodies: unknown[] = [];
    await page.route('**/api/repos/rebase-bots/*', (route) => {
      bodies.push({
        path: new URL(route.request().url()).pathname,
        body: route.request().postDataJSON(),
      });
      return route.fulfill({ status: 204 });
    });
    await page.goto('/webhooks.html');

    const row = page.locator('#webhooks-rows tr').first();
    await expectNoAxeViolations(page);
    await row.getByRole('button', { name: 'Rebase bots: off' }).click();
    await expect(
      row.getByRole('button', { name: 'Rebase bots: on' }),
    ).toBeVisible();
    await expect(page.locator('#webhooks-status')).toContainText(
      'Rebase bots on for alrayyes/a',
    );
    await expectNoAxeViolations(page);

    await row.getByRole('button', { name: 'Rebase bots: on' }).click();
    await expect(
      row.getByRole('button', { name: 'Rebase bots: off' }),
    ).toBeVisible();
    expect(bodies).toEqual([
      {
        path: '/api/repos/rebase-bots/enable',
        body: { forge: 'github', fullName: 'alrayyes/a' },
      },
      {
        path: '/api/repos/rebase-bots/disable',
        body: { forge: 'github', fullName: 'alrayyes/a' },
      },
    ]);
  });

  test('the header buttons switch every repo that needs it', async ({
    page,
  }) => {
    await mockDashboard(page, [
      repo('a'),
      repo('b'),
      repo('c', { rebaseBots: true }),
    ]);
    await page.route('**/api/repos/rebase-bots/*', (route) =>
      route.fulfill({ status: 204 }),
    );
    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto('/webhooks.html');

    await page
      .getByRole('button', { name: 'Rebase bots on for 2 repos' })
      .click();
    await expect(page.locator('#webhooks-status')).toContainText(
      'Rebase bots on for all 2 repos',
    );
    await expect(
      page.getByRole('button', { name: 'Rebase bots off for 3 repos' }),
    ).toBeVisible();
  });

  test('the header button skips a repo whose forge is locked', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [repo('a'), repo('b', { forge: 'forgejo' })],
      [
        {
          forge: 'github',
          reachable: true,
          dependabotCommandsBlocked: 'Dependabot ignores GitHub Apps',
        },
        { forge: 'forgejo', reachable: true },
      ],
    );
    const calls: unknown[] = [];
    await page.route('**/api/repos/rebase-bots/*', (route) => {
      calls.push(route.request().postDataJSON());
      return route.fulfill({ status: 204 });
    });
    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto('/webhooks.html');

    await page
      .getByRole('button', { name: 'Rebase bots on for 1 repo' })
      .click();
    await expect(
      page.getByRole('button', { name: 'Rebase bots off for 1 repo' }),
    ).toBeVisible();
    expect(calls).toEqual([{ forge: 'forgejo', fullName: 'alrayyes/b' }]);
  });

  test('a GitHub App with no token greys the switch and says why', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [repo('a')],
      [
        {
          forge: 'github',
          reachable: true,
          dependabotCommandsBlocked: 'Dependabot ignores GitHub Apps',
        },
      ],
    );
    await page.goto('/webhooks.html');

    const row = page.locator('#webhooks-rows tr').first();
    await expect(
      row.getByRole('button', { name: 'Rebase bots' }),
    ).toBeDisabled();
    await expect(row).toContainText(LOCK_TEXT);
    await expect(
      page.getByRole('button', { name: /^Rebase bots on for/ }),
    ).toHaveCount(0);
    await expectNoAxeViolations(page);
  });
});
