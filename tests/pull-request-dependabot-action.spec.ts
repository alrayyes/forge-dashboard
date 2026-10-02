import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `pr-dependabot-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'PR Dependabot Test User',
  );
}

interface MockLabel {
  name: string;
  color: string;
}

interface MockPR {
  empty?: boolean;
  forge: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  ci: string;
  labels: MockLabel[];
  createdAt: string;
  updatedAt: string;
  mergeStatus: string;
  behind: boolean;
}

function makePR(overrides: Partial<MockPR> = {}): MockPR {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Bump some-package from 1.0.0 to 1.0.1',
    url: 'https://example.com/42',
    author: 'dependabot',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: false,
    ...overrides,
  };
}

function mockDashboard(page: Page, forge: string, pr?: MockPR) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge, reachable: true, repoCount: 1 }],
        pullRequests: pr ? [pr] : [],
        issues: [],
      }),
    }),
  );
}

function mockSettings(page: Page, allowBotPrUpdates?: boolean) {
  return page.route('**/api/settings/bot-pr-updates', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowBotPrUpdates: allowBotPrUpdates || false }),
    }),
  );
}

// Dependabot Rebase/Recreate live behind the row's "More actions" overflow
// trigger (#527) — this opens it, same as a person clicking through.
async function openMoreActions(row: Locator) {
  await row.getByRole('button', { name: 'More actions' }).click();
}

test.describe('pull request Dependabot rebase/recreate buttons', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    await mockSettings(page);
  });

  test('a Dependabot-authored GitHub pull request shows both buttons', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await expect(
      row.getByRole('button', { name: 'Dependabot: Rebase' }),
    ).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Dependabot: Recreate' }),
    ).toBeVisible();
  });

  test('the dependabot[bot] REST-fallback author form also shows both buttons', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR({ author: 'dependabot[bot]' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await expect(
      row.getByRole('button', { name: 'Dependabot: Rebase' }),
    ).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Dependabot: Recreate' }),
    ).toBeVisible();
  });

  test('a pull request not authored by Dependabot shows neither button', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR({ author: 'claude' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: /Dependabot:/ })).toHaveCount(
      0,
    );
  });

  test('a Dependabot-authored pull request on Forgejo shows no button — Dependabot only runs on GitHub', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      'forgejo',
      makePR({ forge: 'forgejo', author: 'dependabot' }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: /Dependabot:/ })).toHaveCount(
      0,
    );
  });

  test('clicking Rebase posts the exact rebase action, with no confirm step', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    let requestBody: unknown;
    await page.route(
      '**/api/pull-requests/dependabot-action',
      (route: Route) => {
        requestBody = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      },
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();

    expect(requestBody).toEqual({
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 42,
      action: 'rebase',
    });
  });

  test('clicking Recreate posts the exact recreate action', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    let requestBody: unknown;
    await page.route(
      '**/api/pull-requests/dependabot-action',
      (route: Route) => {
        requestBody = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      },
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Dependabot: Recreate' }).click();

    expect(requestBody).toMatchObject({ action: 'recreate' });
  });

  test('shows a queued status while requesting, which holds until the next refresh', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route(
      '**/api/pull-requests/dependabot-action',
      async (route: Route) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return route.fulfill({ status: 204 });
      },
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();

    await expect(page.locator('#feedback-toasts')).toContainText(
      'alrayyes/forge-dashboard#42',
    );
    await expect(page.locator('#feedback-toasts')).toContainText(
      'Dependabot rebase requested.',
    );
    await expect(page.locator('#feedback-live')).toHaveAttribute(
      'aria-live',
      'polite',
    );
    await expect(row.locator('.row-feedback')).toContainText(
      'Awaiting the next refresh',
    );
    await expect(page.locator('#status-banner')).toHaveCount(0);
  });

  test('a transient failure shows an error and re-enables the button for another try', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/dependabot-action', (route: Route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: POST .../comments: EOF' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    const button = row.getByRole('button', { name: 'Dependabot: Rebase' });
    await button.click();

    await expect(page.locator('#feedback-toasts')).toContainText('EOF');
    await expect(row.locator('.row-feedback')).toContainText('Failed');
    await expect(page.locator('#error-banner')).toHaveCount(0);
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('a permission-denied failure locks the button for good instead of inviting another try', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/dependabot-action', (route: Route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: POST .../comments: Forbidden',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();

    const button = row.getByRole('button', { name: 'Dependabot: Rebase' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/permission/i);
  });

  // Mirrors pull-request-update-branch.spec.ts's own cross-action
  // forge-wide permission test: forgePermissionDenied is keyed by forge,
  // not by action, since a token's write access isn't specific to one
  // action any more than it's specific to one PR — a 403 from Rebase has
  // to proactively lock Recreate too, for the reason stated there.
  test('a permission failure on Rebase also proactively locks Recreate on the same forge', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route(
      '**/api/pull-requests/dependabot-action',
      (route: Route) => {
        const body = route.request().postDataJSON();
        if (body.action === 'rebase') {
          return route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Forbidden' }),
          });
        }
        return route.fulfill({ status: 204 });
      },
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();

    await expect(
      row.getByRole('button', { name: 'Dependabot: Rebase' }),
    ).toHaveAttribute('aria-disabled', 'true');
    const recreateButton = row.getByRole('button', {
      name: 'Dependabot: Recreate',
    });
    await expect(recreateButton).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/permission/i);
  });

  test('a rate-limited (429) failure locks the button for good', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/dependabot-action', (route: Route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();

    const button = row.getByRole('button', { name: 'Dependabot: Rebase' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/rate limit/i);
  });

  // A Dependabot PR that's actually out of date is the one case #527's
  // "reached rarely enough to collapse" reasoning didn't cover: the
  // person who needs Rebase right then had no visible way to find it.
  // Promoted inline the same way updateBranchActionCell already is for
  // every non-bot pull request — Recreate stays behind "More actions"
  // regardless, since being behind doesn't call for it.
  test.describe('promoted onto the row when out of date', () => {
    test('a behind Dependabot pull request shows Rebase inline, with Recreate still behind More actions', async ({
      page,
    }) => {
      await mockDashboard(page, 'github', makePR({ behind: true }));
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      await expect(
        row.getByRole('button', { name: 'Dependabot: Rebase' }),
      ).toBeVisible();
      await expect(
        row.getByRole('button', { name: 'Dependabot: Recreate' }),
      ).toHaveCount(0);

      await openMoreActions(row);
      await expect(
        row.getByRole('button', { name: 'Dependabot: Recreate' }),
      ).toBeVisible();
    });

    test('clicking the promoted Rebase button posts the same rebase action', async ({
      page,
    }) => {
      await mockDashboard(page, 'github', makePR({ behind: true }));
      let requestBody: unknown;
      await page.route(
        '**/api/pull-requests/dependabot-action',
        (route: Route) => {
          requestBody = route.request().postDataJSON();
          return route.fulfill({ status: 204 });
        },
      );
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();

      expect(requestBody).toEqual({
        forge: 'github',
        fullName: 'alrayyes/forge-dashboard',
        number: 42,
        action: 'rebase',
      });
    });

    // Mirrors updateBranchActionCell's own empty-pull-request exception
    // (#543) — nothing left to merge means asking the bot to rebase
    // wouldn't change anything, so Rebase stays exactly where it was
    // rather than being promoted onto a row with nothing to gain from it.
    test('an empty, behind Dependabot pull request keeps both buttons behind More actions', async ({
      page,
    }) => {
      await mockDashboard(
        page,
        'github',
        makePR({ behind: true, empty: true }),
      );
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      await expect(
        row.getByRole('button', { name: 'Dependabot: Rebase' }),
      ).toHaveCount(0);

      await openMoreActions(row);
      await expect(
        row.getByRole('button', { name: 'Dependabot: Rebase' }),
      ).toBeVisible();
    });
  });

  test('a locked button is reachable by keyboard and has no axe-core violations', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.route('**/api/pull-requests/dependabot-action', (route: Route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();
    await expect(
      row.getByRole('button', { name: 'Dependabot: Rebase' }),
    ).toHaveAttribute('aria-disabled', 'true');

    await page.keyboard.press('Tab');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a GitHub App with no personal token locks both buttons with the reason, and clicking sends nothing (#666)', async ({
    page,
  }) => {
    const reason =
      'Dependabot ignores commands from GitHub Apps. Save a personal access token in Settings to send them as you.';
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            {
              forge: 'github',
              reachable: true,
              repoCount: 1,
              dependabotCommandsBlocked: reason,
            },
          ],
          pullRequests: [makePR({ behind: true })],
          issues: [],
        }),
      }),
    );
    let posted = false;
    await page.route(
      '**/api/pull-requests/dependabot-action',
      (route: Route) => {
        posted = true;
        return route.fulfill({ status: 204 });
      },
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    const rebase = row.getByRole('button', { name: 'Dependabot: Rebase' });
    await expect(rebase).toHaveAttribute('aria-disabled', 'true');
    await expect(rebase).toHaveAccessibleDescription(reason);
    await rebase.click({ force: true });

    await openMoreActions(row);
    const recreate = row.getByRole('button', {
      name: 'Dependabot: Recreate',
    });
    await expect(recreate).toHaveAttribute('aria-disabled', 'true');
    await expect(recreate).toHaveAccessibleDescription(reason);
    await recreate.click({ force: true });

    expect(posted).toBe(false);
  });
});
