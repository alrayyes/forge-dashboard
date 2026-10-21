import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import {
  actionsFeedback,
  actionsFooter,
  openActionsDialog,
} from './actions-dialog-helper';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// After a Close from the details dialog the dialog stays open on the pull
// request, says it is closed and offers Reopen as the undo, with no timer. The
// forge decides whether a reopen is possible, so a refusal is shown in words
// with no Reopen left. Mocks /api/dashboard, the details endpoint and the
// close and reopen endpoints only, so it starts from the shared session.
//
// Undo over a confirm step, and a status line over a toast:
// https://developer.gnome.org/hig/patterns/feedback/dialogs.html
// https://notes.andymatuschak.org/zXH4ASvHNz488hCNgrBjQJK
// https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/ and
// https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/status_role
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

const now = new Date().toISOString();

const pr = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 42,
  title: 'Add structured logging',
  url: 'https://example.com/42',
  author: 'ryankes',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: now,
  updatedAt: now,
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
  allowedActions: [{ action: 'merge', primary: true }, { action: 'close' }],
};

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

type Answer = { status: number; body?: unknown };

// The board follows what the forge would say: a close takes the pull request
// off it, a successful reopen puts it back.
async function start(
  page: Page,
  reopen: Answer = { status: 204 },
  { refreshFails = false }: { refreshFails?: boolean } = {},
) {
  const state = { onBoard: true, posted: [] as string[] };
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  for (const glob of ['**/api/dashboard*', '**/api/dashboard/refresh*'])
    await page.route(glob, (route: Route) => {
      if (refreshFails && glob.includes('refresh')) return route.abort();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: state.onBoard ? [pr] : [],
          issues: [],
          repos: [],
          hiddenDrafts: 0,
        }),
      });
    });
  await page.route('**/api/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: 'The description.',
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions: noReactions,
        },
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
        releaseNotes: null,
      }),
    }),
  );
  await page.route('**/api/pull-requests/close', (route: Route) => {
    state.posted.push('close');
    state.onBoard = false;
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/pull-requests/reopen', (route: Route) => {
    state.posted.push('reopen');
    if (reopen.status === 204) state.onBoard = true;
    return route.fulfill({
      status: reopen.status,
      contentType: 'application/json',
      body: reopen.body === undefined ? '' : JSON.stringify(reopen.body),
    });
  });
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows .row')).toHaveCount(1);
  return state;
}

async function closeFromDialog(page: Page) {
  const dialog = await openActionsDialog(page.locator('#pr-rows .row').first());
  const footer = actionsFooter(dialog);
  await footer
    .getByRole('button', { name: 'Close pull request', exact: true })
    .click();
  await footer
    .getByRole('button', { name: 'Confirm close pull request?', exact: true })
    .click();
  return dialog;
}

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test('a close from the dialog keeps it open on the closed state, with Reopen focused', async ({
  page,
}) => {
  await start(page);
  const dialog = await closeFromDialog(page);
  const reopen = actionsFooter(dialog).getByRole('button', {
    name: 'Reopen pull request',
  });

  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.details-state')).toContainText('Closed');
  await expect(dialog.locator('.details-closed')).toHaveText(
    'Closed. Reopen it if that was a mistake.',
  );
  await expect(reopen).toBeFocused();
  await expect(
    actionsFooter(dialog).getByRole('button', { name: 'Close pull request' }),
  ).toHaveCount(0);
  await expect(
    actionsFooter(dialog).getByRole('link', { name: /Open on GitHub/ }),
  ).toBeVisible();
  // Said once, to a screen reader, without moving focus.
  await expect(dialog.locator('[role="status"].visually-hidden')).toHaveText(
    'alrayyes/forge-dashboard#42: Closed. Reopen it if that was a mistake.',
  );
});

test('the closed state passes axe in light, dark and at 390px', async ({
  page,
}) => {
  await start(page);
  const dialog = await closeFromDialog(page);
  await expect(dialog.locator('.details-closed')).toBeVisible();

  await page.emulateMedia({ colorScheme: 'light' });
  await expectNoViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoViolations(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await expectNoViolations(page);
});

test('Reopen puts the pull request back and the dialog returns to its normal state', async ({
  page,
}) => {
  const state = await start(page);
  const dialog = await closeFromDialog(page);
  await actionsFooter(dialog)
    .getByRole('button', { name: 'Reopen pull request' })
    .click();

  await expect(
    actionsFooter(dialog).getByRole('button', {
      name: 'Close pull request',
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.locator('.details-closed')).toHaveCount(0);
  await expect(dialog.locator('.details-state')).not.toContainText('Closed');
  expect(state.posted).toEqual(['close', 'reopen']);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#pr-rows .row')).toHaveCount(1);
});

test('closing the dialog without reopening leaves the row off the board', async ({
  page,
}) => {
  await start(page);
  const dialog = await closeFromDialog(page);
  await expect(dialog.locator('.details-closed')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#pr-rows .row')).toHaveCount(0);
});

test('a reopen the forge refuses says why and leaves no Reopen to press', async ({
  page,
}) => {
  await start(page, {
    status: 409,
    body: {
      error: 'head branch was deleted',
      code: 'not_reopenable',
      message:
        "The forge won't reopen this pull request. Usually its branch was deleted or rewritten after it was closed: restore the branch on the forge, then try again.",
    },
  });
  const dialog = await closeFromDialog(page);
  await actionsFooter(dialog)
    .getByRole('button', { name: 'Reopen pull request' })
    .click();

  await expect(dialog.locator('.details-closed')).toHaveText(
    "Closed. It can't be reopened from here.",
  );
  await expect(actionsFeedback(dialog)).toContainText(
    'restore the branch on the forge',
  );
  await expect(
    actionsFeedback(dialog).getByRole('button', { name: /Copy/ }),
  ).toBeVisible();
  await expect(
    actionsFooter(dialog).getByRole('button', { name: /Reopen/ }),
  ).toHaveCount(0);
  await expect(
    actionsFooter(dialog).getByRole('link', { name: /Open on GitHub/ }),
  ).toBeVisible();
  await expectNoViolations(page);
});

test('a reopen of a pull request that was merged meanwhile says so and leaves no Reopen', async ({
  page,
}) => {
  await start(page, {
    status: 409,
    body: {
      error: 'already merged',
      code: 'already_merged',
      message: 'This pull request was already merged.',
    },
  });
  const dialog = await closeFromDialog(page);
  await actionsFooter(dialog)
    .getByRole('button', { name: 'Reopen pull request' })
    .click();

  await expect(actionsFeedback(dialog)).toContainText(
    "It was merged in the meantime, so it can't be reopened.",
  );
  await expect(
    actionsFooter(dialog).getByRole('button', { name: /Reopen/ }),
  ).toHaveCount(0);
});

test('a forge error on reopen shows its reason with Copy and keeps Reopen to try again', async ({
  page,
}) => {
  await start(page, {
    status: 502,
    body: {
      error: 'boom',
      code: 'unknown',
      message: 'The forge refused this action and gave no reason.',
    },
  });
  const dialog = await closeFromDialog(page);
  await actionsFooter(dialog)
    .getByRole('button', { name: 'Reopen pull request' })
    .click();

  await expect(actionsFeedback(dialog)).toContainText('gave no reason');
  await expect(
    actionsFeedback(dialog).getByRole('button', { name: /Copy/ }),
  ).toBeVisible();
  await expect(
    actionsFooter(dialog).getByRole('button', { name: 'Reopen pull request' }),
  ).toBeVisible();
});

test('a page refresh that fails after a good reopen is not shown as a failed reopen', async ({
  page,
}) => {
  const state = await start(page, { status: 204 }, { refreshFails: true });
  const dialog = await closeFromDialog(page);
  await actionsFooter(dialog)
    .getByRole('button', { name: 'Reopen pull request' })
    .click();

  await expect(
    actionsFooter(dialog).getByRole('button', {
      name: 'Close pull request',
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.locator('.details-closed')).toHaveCount(0);
  await expect(actionsFeedback(dialog)).not.toContainText(/fail|retry/i);
  await expect(
    actionsFooter(dialog).getByRole('button', { name: /Retry|Reopen/ }),
  ).toHaveCount(0);
  expect(state.posted).toEqual(['close', 'reopen']);
});

test('a page refresh that fails after a good close still shows the closed state', async ({
  page,
}) => {
  const state = await start(page, { status: 204 }, { refreshFails: true });
  const dialog = await closeFromDialog(page);

  await expect(dialog.locator('.details-closed')).toBeVisible();
  await expect(
    actionsFooter(dialog).getByRole('button', { name: 'Reopen pull request' }),
  ).toBeVisible();
  await expect(actionsFeedback(dialog)).not.toContainText(/fail|retry/i);
  expect(state.posted).toEqual(['close']);
});
