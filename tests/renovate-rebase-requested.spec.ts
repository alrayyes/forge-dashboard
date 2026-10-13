import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { rateLimit } from './severity-stand-in';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The tests mock /api/dashboard and write nothing per user, so they start from
// the shared session instead of registering a user each (#1379).
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

// While Renovate's rebase checkbox is ticked a rebase is already waiting, so
// the server blocks a second request and the row says so instead of offering
// a button that would only be refused (#1349).
// https://github.com/alrayyes/forge-dashboard/issues/1349

const BLOCKED = {
  action: 'renovate_rebase',
  blocked: {
    code: 'already_requested',
    message: 'A Renovate rebase is already requested on this pull request.',
    next: 'Renovate clears the box once it has rebased, and the rebase is offered again.',
  },
};

function makePR(
  rebase: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
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
    ...extra,
  };
}

type State = {
  rebase: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

async function serve(
  page: Page,
  state: State,
  forge: Record<string, unknown> = {},
) {
  const answer = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'forgejo', reachable: true, repoCount: 1, ...forge }],
        pullRequests: [makePR(state.rebase, state.extra)],
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
  test.beforeEach(async ({ page }) => {
    await page.goto('/pull-requests.html');
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

  test('the reason is said once on screen, with what happens next under it', async ({
    page,
  }) => {
    await serve(page, { rebase: BLOCKED });
    const row = await open(page);

    const text = await row.innerText();
    expect(text.split('already requested')).toHaveLength(2);
    await expect(row.locator('.row-action-note-reason')).toHaveText(
      BLOCKED.blocked.message,
    );
    await expect(row.locator('.row-action-note-next')).toHaveText(
      BLOCKED.blocked.next,
    );
  });

  // A rebase asked for on this page has its own pending button; the blocked
  // note is for a box ticked elsewhere, so the row does not say it twice.
  test('a rebase asked for here shows the pending button, not the blocked note', async ({
    page,
  }) => {
    await page.route('**/api/pull-requests/renovate-rebase', (route: Route) =>
      route.fulfill({ status: 204 }),
    );
    const state: State = { rebase: { action: 'renovate_rebase' } };
    await serve(page, state);
    const row = await open(page);
    await row.getByRole('button', { name: 'Renovate: Rebase' }).click();

    // The box is now ticked, so the next snapshot blocks a second request, and
    // the server carries the request this page made as `botRequest`.
    state.rebase = BLOCKED;
    state.extra = {
      botRequest: {
        bot: 'renovate',
        action: 'rebase',
        phase: 'queued',
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    };
    await page.locator('#force-refresh-button').click();
    await row.getByRole('button', { name: 'More actions' }).click();

    await expect(
      row.getByRole('button', { name: /Rebase requested/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(row.locator('.row-action-note-reason')).toHaveCount(0);
  });

  test('a rate-limited forge draws no Renovate control, blocked or not', async ({
    page,
  }) => {
    const resetsAt = new Date(Date.now() + 12 * 60_000).toISOString();
    await serve(
      page,
      { rebase: BLOCKED },
      { rateLimitREST: rateLimit(5000, 0, resetsAt) },
    );
    await page.goto('/bots.html');
    const row = page.locator('#pr-rows .row').first();
    await expect(row).toBeVisible();
    // The read-only controls are drawn, so a missing Renovate control is not
    // just a row that had not rendered, and the menu holds nothing to open.
    await expect(
      row.getByRole('button', { name: /Open pipeline/ }),
    ).toBeVisible();
    await expect(row.getByRole('button', { name: 'More actions' })).toHaveCount(
      0,
    );

    await expect(
      row.getByRole('button', { name: 'Renovate: Rebase' }),
    ).toHaveCount(0);
    await expect(row.locator('.row-action-note-reason')).toHaveCount(0);
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

    const button = row.getByRole('button', { name: 'Renovate: Rebase' });
    await expect(button).toHaveAccessibleDescription(/already requested/);
    // Said once: the description is the reason and the line under it.
    const description = await button.evaluate(
      (el) =>
        document.getElementById(el.getAttribute('aria-describedby') ?? '')
          ?.textContent,
    );
    expect(description?.split('already requested')).toHaveLength(2);
  });

  test('when the box is cleared the next snapshot offers the rebase again, without a reload', async ({
    page,
  }) => {
    const state: State = { rebase: BLOCKED };
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
