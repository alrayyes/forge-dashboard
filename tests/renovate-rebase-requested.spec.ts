import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// While Renovate's rebase checkbox is ticked a rebase is already waiting, so
// the server blocks a second request and the row says so instead of offering
// a button that would only be refused (#1349).
// https://github.com/alrayyes/forge-dashboard/issues/1349

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `rebase-req-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Rebase Requested');
}

const BLOCKED = {
  action: 'renovate_rebase',
  blocked: {
    code: 'already_requested',
    message: 'A Renovate rebase is already requested on this pull request.',
    next: 'Renovate clears the box once it has rebased, and the rebase is offered again.',
  },
};

function makePR(rebase: Record<string, unknown>) {
  return {
    forge: 'forgejo',
    repo: 'alrayyes/scaffold-python-cli',
    number: 77,
    title: 'Update dependency foo to v2',
    url: 'https://example.com/77',
    author: 'renovate[bot]',
    kind: 'dependency',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    allowedActions: [{ action: 'merge' }, { action: 'close' }, rebase],
  };
}

async function serve(page: Page, state: { rebase: Record<string, unknown> }) {
  const answer = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
        pullRequests: [makePR(state.rebase)],
        issues: [],
      }),
    });
  await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/dashboard*', answer);
  await page.route('**/api/dashboard/refresh*', answer);
}

const open = async (page: Page) => {
  await page.goto('/bots.html');
  const row = page.locator('#pr-rows .row').first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'More actions' }).click();
  return row;
};

test.describe('Renovate: Rebase while its box is ticked (#1349)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('the button is disabled and says a rebase is already requested', async ({
    page,
  }) => {
    await serve(page, { rebase: BLOCKED });
    const row = await open(page);

    const button = row.getByRole('button', { name: 'Renovate: Rebase' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(
      'A Renovate rebase is already requested on this pull request.',
    );
  });

  test('clicking it sends nothing', async ({ page }) => {
    let posts = 0;
    await page.route('**/api/pull-requests/renovate-rebase', (route: Route) => {
      posts += 1;
      return route.fulfill({ status: 204 });
    });
    await serve(page, { rebase: BLOCKED });
    const row = await open(page);

    // Forced, since Playwright won't click a disabled button on its own.
    await row
      .getByRole('button', { name: 'Renovate: Rebase' })
      .click({ force: true });
    await page.waitForTimeout(300);

    expect(posts).toBe(0);
  });

  test('the reason is the button’s description for assistive tech', async ({
    page,
  }) => {
    await serve(page, { rebase: BLOCKED });
    const row = await open(page);

    await expect(
      row.getByRole('button', { name: 'Renovate: Rebase' }),
    ).toHaveAccessibleDescription(/already requested/);
  });

  test('when the box is cleared the next snapshot offers the rebase again, without a reload', async ({
    page,
  }) => {
    const state = { rebase: BLOCKED as Record<string, unknown> };
    await serve(page, state);
    const row = await open(page);
    await expect(
      row.getByRole('button', { name: 'Renovate: Rebase' }),
    ).toHaveAttribute('aria-disabled', 'true');

    state.rebase = { action: 'renovate_rebase' };
    await page.locator('#force-refresh-button').click();
    await row.getByRole('button', { name: 'More actions' }).click();

    await expect(
      row.getByRole('button', { name: 'Renovate: Rebase' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('an unblocked rebase still posts for that pull request', async ({
    page,
  }) => {
    let posted: unknown = null;
    await page.route('**/api/pull-requests/renovate-rebase', (route: Route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await serve(page, { rebase: { action: 'renovate_rebase' } });
    const row = await open(page);

    await row.getByRole('button', { name: 'Renovate: Rebase' }).click();

    await expect
      .poll(() => posted)
      .toEqual({
        forge: 'forgejo',
        fullName: 'alrayyes/scaffold-python-cli',
        number: 77,
      });
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe violations with the blocked button (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await serve(page, { rebase: BLOCKED });
      const row = await open(page);
      await expect(row).toContainText('already requested');

      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
    });
  }
});
