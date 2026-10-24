import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { closeActionsDialog, openActionsDialog } from './actions-dialog-helper';
import { test } from './server-fixture';
import { settle } from './settle-helper';
import { rateLimit } from './severity-stand-in';

// Once a Renovate rebase is requested the pull request offers the cancel and
// no second request: the server lists `cancel_renovate_rebase` instead of
// `renovate_rebase`, and the page draws what the list says.
// https://github.com/alrayyes/forge-dashboard/issues/2748

const REQUEST = { action: 'renovate_rebase' };
const CANCEL = { action: 'cancel_renovate_rebase' };

const BOT_REQUEST = {
  bot: 'renovate',
  action: 'rebase',
  phase: 'queued',
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
};

function makePR(
  rebase: Record<string, unknown> | null,
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
    allowedActions: [
      { action: 'merge' },
      { action: 'close' },
      ...(rebase ? [rebase] : []),
    ],
    ...extra,
  };
}

type State = {
  // Pins the snapshot's time, so a refresh can answer with the very snapshot
  // the page already holds, as a cooldown answer does.
  at?: string;
  rebase: Record<string, unknown> | null;
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
        generatedAt: state.at ?? new Date().toISOString(),
        forges: [{ forge: 'forgejo', reachable: true, repoCount: 1, ...forge }],
        pullRequests: [makePR(state.rebase, state.extra)],
        issues: [],
      }),
    });
  await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/dashboard*', answer);
  await page.route('**/api/dashboard/refresh*', answer);
}

const rowOf = (page: Page) => page.locator('#pr-rows .row').first();

const openRow = async (page: Page) => {
  await page.goto('/bots.html');
  const row = rowOf(page);
  await expect(row).toBeVisible();
  return row;
};

const open = async (page: Page) => openActionsDialog(await openRow(page));

const CANCEL_NAME = 'Cancel Renovate rebase';
const REQUEST_NAME = 'Renovate: Rebase';

test.describe('A requested Renovate rebase offers only the cancel (#2748)', () => {
  test('the row draws the cancel and no request button', async ({ page }) => {
    await serve(page, { rebase: CANCEL, extra: { botRequest: BOT_REQUEST } });
    const row = await openRow(page);

    await expect(row.getByRole('button', { name: CANCEL_NAME })).toBeVisible();
    await expect(row.getByRole('button', { name: REQUEST_NAME })).toHaveCount(
      0,
    );
    await expect(row.locator('.row-action-note-reason')).toHaveCount(0);
  });

  test('the dialog draws the cancel and no request button', async ({
    page,
  }) => {
    await serve(page, { rebase: CANCEL, extra: { botRequest: BOT_REQUEST } });
    const dialog = await open(page);

    await expect(
      dialog.getByRole('button', { name: CANCEL_NAME }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: REQUEST_NAME }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: /Rebase requested/ }),
    ).toHaveCount(0);
    await expect(dialog.locator('.row-action-note-reason')).toHaveCount(0);
    expect(await dialog.innerText()).not.toContain('already requested');
  });

  test('cancelling posts for that pull request and takes the list the server sends next', async ({
    page,
  }) => {
    let posted: unknown = null;
    const state: State = { rebase: CANCEL };
    await page.route(
      '**/api/pull-requests/renovate-rebase/cancel',
      (route: Route) => {
        posted = route.request().postDataJSON();
        // The box is clear, so the next snapshot offers the request again.
        state.rebase = REQUEST;
        return route.fulfill({ status: 204 });
      },
    );
    await serve(page, state);
    const dialog = await open(page);

    await dialog.getByRole('button', { name: CANCEL_NAME }).click();

    await expect
      .poll(() => posted)
      .toEqual({
        forge: 'forgejo',
        fullName: 'alrayyes/scaffold-python-cli',
        number: 77,
      });
    await settle(page);
    await expect(
      page.getByRole('button', { name: REQUEST_NAME }).first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: CANCEL_NAME })).toHaveCount(
      0,
    );
  });

  test('a refresh that fails after the cancel does not leave Cancelling… on the board', async ({
    page,
  }) => {
    let cancelled = false;
    await serve(page, { rebase: CANCEL, extra: { botRequest: BOT_REQUEST } });
    await page.route('**/api/dashboard/refresh*', (route: Route) =>
      cancelled
        ? route.fulfill({ status: 500, body: 'down' })
        : route.fallback(),
    );
    await page.route(
      '**/api/pull-requests/renovate-rebase/cancel',
      (route: Route) => {
        cancelled = true;
        return route.fulfill({ status: 204 });
      },
    );
    const row = await openRow(page);

    await row.getByRole('button', { name: CANCEL_NAME }).click();

    await expect(row.getByRole('button', { name: 'Cancelling…' })).toHaveCount(
      0,
    );
  });

  test('a refresh that fails after the cancel does not draw the cancel again from the old snapshot', async ({
    page,
  }) => {
    let cancelled = false;
    await serve(page, { rebase: CANCEL, extra: { botRequest: BOT_REQUEST } });
    await page.route('**/api/dashboard/refresh*', (route: Route) =>
      cancelled
        ? route.fulfill({ status: 500, body: 'down' })
        : route.fallback(),
    );
    await page.route(
      '**/api/pull-requests/renovate-rebase/cancel',
      (route: Route) => {
        cancelled = true;
        return route.fulfill({ status: 204 });
      },
    );
    const row = await openRow(page);

    await row.getByRole('button', { name: CANCEL_NAME }).click();

    await expect(row.getByRole('button', { name: 'Cancelling…' })).toHaveCount(
      0,
    );
    await settle(page);
    await expect(row.getByRole('button', { name: CANCEL_NAME })).toHaveCount(0);
  });

  test('a refresh that repeats the old snapshot after the cancel does not draw the cancel again', async ({
    page,
  }) => {
    await serve(page, {
      at: new Date().toISOString(),
      rebase: CANCEL,
      extra: { botRequest: BOT_REQUEST },
    });
    await page.route(
      '**/api/pull-requests/renovate-rebase/cancel',
      (route: Route) => route.fulfill({ status: 204 }),
    );
    const row = await openRow(page);

    await row.getByRole('button', { name: CANCEL_NAME }).click();
    await expect(row.getByRole('button', { name: 'Cancelling…' })).toHaveCount(
      0,
    );
    await settle(page);

    await expect(row.getByRole('button', { name: CANCEL_NAME })).toHaveCount(0);
  });

  test('a rebase requested again after a cancel whose refresh failed offers the cancel again', async ({
    page,
  }) => {
    const state: State = {
      rebase: CANCEL,
      extra: { botRequest: BOT_REQUEST },
    };
    let down = false;
    await serve(page, state);
    await page.route('**/api/dashboard/refresh*', (route: Route) =>
      down ? route.fulfill({ status: 500, body: 'down' }) : route.fallback(),
    );
    await page.route(
      '**/api/pull-requests/renovate-rebase/cancel',
      (route: Route) => {
        down = true;
        return route.fulfill({ status: 204 });
      },
    );
    const row = await openRow(page);
    await row.getByRole('button', { name: CANCEL_NAME }).click();
    await expect(row.getByRole('button', { name: 'Cancelling…' })).toHaveCount(
      0,
    );
    await settle(page);
    await expect(row.getByRole('button', { name: CANCEL_NAME })).toHaveCount(0);

    // The forge took the cancel, then someone ticked the box again.
    down = false;
    state.rebase = REQUEST;
    state.extra = {};
    await page.locator('#force-refresh-button').click();
    const dialog = await openActionsDialog(row);
    await expect(
      dialog.getByRole('button', { name: REQUEST_NAME }),
    ).toBeVisible();
    await closeActionsDialog(dialog);
    state.rebase = CANCEL;
    state.extra = { botRequest: BOT_REQUEST };
    await page.locator('#force-refresh-button').click();

    await expect(row.getByRole('button', { name: CANCEL_NAME })).toBeVisible();
  });

  test('a refused cancel says why and keeps the cancel', async ({ page }) => {
    await page.route(
      '**/api/pull-requests/renovate-rebase/cancel',
      (route: Route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Renovate already cleared the box.',
            code: 'already_up_to_date',
            message: 'Renovate already cleared the box.',
          }),
        }),
    );
    await serve(page, { rebase: CANCEL });
    const row = await openRow(page);

    await row.getByRole('button', { name: CANCEL_NAME }).click();

    await expect(row.locator('.row-feedback-text')).toContainText(
      'Renovate already cleared the box.',
    );
  });

  // A request with no box to clear (the label, or a command still queued) has
  // no way back, so the list holds neither action and the wait chip stays.
  test('a request with no cancel draws neither button and keeps the chip', async ({
    page,
  }) => {
    await serve(page, { rebase: null, extra: { botRequest: BOT_REQUEST } });
    const dialog = await open(page);

    await expect(
      dialog.getByRole('button', { name: REQUEST_NAME }),
    ).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: CANCEL_NAME })).toHaveCount(
      0,
    );
    await expect(dialog.locator('.row-action-note-reason')).toHaveCount(0);
    await expect(rowOf(page).locator('.wait-chip').first()).toBeVisible();
  });

  test('when the box is cleared the next snapshot offers the rebase again, without a reload', async ({
    page,
  }) => {
    const state: State = { rebase: CANCEL };
    await serve(page, state);
    const dialog = await open(page);
    await expect(
      dialog.getByRole('button', { name: CANCEL_NAME }),
    ).toBeVisible();

    state.rebase = REQUEST;
    await closeActionsDialog(dialog);
    await page.locator('#force-refresh-button').click();
    const reopened = await openActionsDialog(rowOf(page));

    await expect(
      reopened.getByRole('button', { name: REQUEST_NAME }),
    ).toBeVisible();
    await expect(
      reopened.getByRole('button', { name: CANCEL_NAME }),
    ).toHaveCount(0);
  });

  test('a rate-limited forge draws no Renovate control', async ({ page }) => {
    const resetsAt = new Date(Date.now() + 12 * 60_000).toISOString();
    await serve(
      page,
      { rebase: null },
      { rateLimitREST: rateLimit(5000, 0, resetsAt) },
    );
    const row = await openRow(page);
    // The read-only controls are drawn, so a missing Renovate control is not
    // just a row that had not rendered.
    await expect(
      row.getByRole('button', { name: /Open pipeline/ }),
    ).toBeVisible();

    await expect(row.getByRole('button', { name: REQUEST_NAME })).toHaveCount(
      0,
    );
    await expect(row.getByRole('button', { name: CANCEL_NAME })).toHaveCount(0);
  });

  test('an unrequested rebase still posts for that pull request', async ({
    page,
  }) => {
    let posted: unknown = null;
    await page.route('**/api/pull-requests/renovate-rebase', (route: Route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await serve(page, { rebase: REQUEST });
    const dialog = await open(page);

    await dialog.getByRole('button', { name: REQUEST_NAME }).click();

    await expect
      .poll(() => posted)
      .toEqual({
        forge: 'forgejo',
        fullName: 'alrayyes/scaffold-python-cli',
        number: 77,
      });
  });

  // A refused cancel (a token that can't edit the description) is a lock with
  // its reason, not an enabled button that fails again the same way.
  test('a permission-refused cancel draws a locked cancel with the reason', async ({
    page,
  }) => {
    await page.route(
      '**/api/pull-requests/renovate-rebase/cancel',
      (route: Route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'The token cannot edit this description.',
            code: 'permission',
            message: 'The token cannot edit this description.',
          }),
        }),
    );
    await serve(page, { rebase: CANCEL });
    const row = await openRow(page);

    await row.getByRole('button', { name: CANCEL_NAME }).click();

    const locked = row.getByRole('button', { name: CANCEL_NAME });
    await expect(locked).toHaveAttribute('aria-disabled', 'true');
    await expect(locked).toHaveAccessibleDescription(/Missing permission/);
  });

  test('a rate-limited forge draws no cancel either', async ({ page }) => {
    const resetsAt = new Date(Date.now() + 12 * 60_000).toISOString();
    await serve(
      page,
      { rebase: CANCEL, extra: { botRequest: BOT_REQUEST } },
      { rateLimitREST: rateLimit(5000, 0, resetsAt) },
    );
    const row = await openRow(page);
    await expect(
      row.getByRole('button', { name: /Open pipeline/ }),
    ).toBeVisible();

    await expect(row.getByRole('button', { name: CANCEL_NAME })).toHaveCount(0);
  });

  // The request turns into the cancel when the next snapshot lands. A keyboard
  // user who pressed Enter on the request keeps their place in the row.
  test('keyboard: focus moves to the cancel when the request turns into it', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as {
        __streams: EventSource[];
        EventSource: typeof EventSource;
      };
      w.__streams = [];
      const Real = w.EventSource;
      w.EventSource = class extends Real {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          w.__streams.push(this);
        }
      };
    });
    await page.route('**/api/pull-requests/renovate-rebase', (route: Route) =>
      route.fulfill({ status: 204 }),
    );
    // Merge is the primary action of a behind, mergeable pull request, so the
    // rebase sits beside it on the row.
    const withMerge = (action: Record<string, unknown>) => [
      { action: 'merge', primary: true },
      { action: 'close' },
      action,
    ];
    const state: State = {
      rebase: REQUEST,
      extra: { behind: true, allowedActions: withMerge(REQUEST) },
    };
    await serve(page, state);
    await page.route('**/api/dashboard/stream*', (r: Route) => r.continue());
    const row = await openRow(page);

    await row.getByRole('button', { name: REQUEST_NAME }).focus();
    await page.keyboard.press('Enter');
    await expect(
      row.getByRole('button', { name: /Rebase requested/ }),
    ).toBeVisible();

    const pr = makePR(CANCEL, {
      behind: true,
      botRequest: BOT_REQUEST,
      allowedActions: withMerge(CANCEL),
    });
    await page.evaluate(
      (data) => {
        const w = window as unknown as { __streams: EventSource[] };
        for (const stream of w.__streams)
          stream.onmessage?.(new MessageEvent('message', { data }));
      },
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
        pullRequests: [pr],
        issues: [],
      }),
    );

    const cancel = row.getByRole('button', { name: CANCEL_NAME });
    await expect(cancel).toBeVisible();
    await expect(cancel).toBeFocused();
  });

  // The cancel redraws as a pending button while it posts, then the request
  // button returns. A keyboard user stays on the control through both swaps.
  test('keyboard: focus stays through the cancel and lands on the returning request', async ({
    page,
  }) => {
    const withMerge = (action: Record<string, unknown>) => [
      { action: 'merge', primary: true },
      { action: 'close' },
      action,
    ];
    const state: State = {
      rebase: CANCEL,
      extra: {
        behind: true,
        botRequest: BOT_REQUEST,
        allowedActions: withMerge(CANCEL),
      },
    };
    await page.route(
      '**/api/pull-requests/renovate-rebase/cancel',
      async (route: Route) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        state.rebase = REQUEST;
        state.extra = { behind: true, allowedActions: withMerge(REQUEST) };
        return route.fulfill({ status: 204 });
      },
    );
    await serve(page, state);
    const row = await openRow(page);

    const cancel = row.getByRole('button', { name: CANCEL_NAME });
    await cancel.focus();
    await page.keyboard.press('Enter');

    // While posting, the pending cancel still holds the focus.
    await expect(
      row.getByRole('button', { name: 'Cancelling…' }),
    ).toBeFocused();
    await expect(row.getByRole('button', { name: REQUEST_NAME })).toBeFocused();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe violations with the cancel (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await serve(page, { rebase: CANCEL, extra: { botRequest: BOT_REQUEST } });
      const dialog = await open(page);
      await expect(
        dialog.getByRole('button', { name: CANCEL_NAME }),
      ).toBeVisible();

      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
    });
  }

  test('has no axe violations with the cancel at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serve(page, { rebase: CANCEL, extra: { botRequest: BOT_REQUEST } });
    const dialog = await open(page);
    await expect(
      dialog.getByRole('button', { name: CANCEL_NAME }),
    ).toBeVisible();

    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
});
