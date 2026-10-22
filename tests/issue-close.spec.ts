import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The issue dialog closes its issue, with or without a comment, the way the
// pull request dialog closes a pull request: a confirm step, the dialog stays
// open, the status pill switches to Closed and Reopen is the undo. A comment
// posts first and the close second, so a half that failed is named and only
// that half is offered again. Mocks /api/dashboard, the details endpoint and
// the three issue action endpoints only, so it needs no second user.
//
// Confirm over a bare click, and a status line over a toast:
// https://developer.gnome.org/hig/patterns/feedback/dialogs.html
// https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/
// https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/status_role

const NOW = new Date().toISOString();

const ISSUE = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 7,
  title: 'The page loses its place',
  url: 'https://example.com/issues/7',
  author: 'ryankes',
  labels: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

type Answer = { status: number; body?: unknown };

type Posted = { path: string; body: Record<string, unknown> };

// The forge follows what was posted: a close makes the issue closed, a
// reopen makes it open again. The details endpoint reports that state.
async function start(
  page: Page,
  answers: Partial<Record<'close' | 'reopen' | 'comment', Answer[]>> = {},
) {
  const state = { closed: false as boolean, posted: [] as Posted[] };
  const queue = {
    close: [...(answers.close ?? [])],
    reopen: [...(answers.reopen ?? [])],
    comment: [...(answers.comment ?? [])],
  };
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: state.closed ? [] : [ISSUE],
      }),
    }),
  );
  await page.route('**/api/issues/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: state.closed ? 'closed' : 'open',
        description: {
          text: 'It jumps back to the top.',
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions: noReactions,
        },
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
      }),
    }),
  );
  for (const kind of ['close', 'reopen', 'comment'] as const) {
    await page.route(`**/api/issues/${kind}`, (route: Route) => {
      state.posted.push({
        path: kind,
        body: route.request().postDataJSON() ?? {},
      });
      const answer = queue[kind].shift() ?? { status: 204 };
      if (answer.status === 204) {
        if (kind === 'close') state.closed = true;
        if (kind === 'reopen') state.closed = false;
      }
      return route.fulfill({
        status: answer.status,
        contentType: 'application/json',
        body: answer.body === undefined ? '' : JSON.stringify(answer.body),
      });
    });
  }
  await page.goto('/issues.html');
  await page.getByRole('button', { name: /^#7 / }).click();
  const dialog = page.getByRole('dialog', { name: /^Issue details/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('It jumps back to the top.')).toBeVisible();
  return { state, dialog };
}

async function expectNoViolations(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const footer = (dialog: ReturnType<Page['locator']>) =>
  dialog.locator('.details-footer');

test('the footer offers Close and Close with a comment, beside the link to the forge', async ({
  page,
}) => {
  const { dialog } = await start(page);

  await expect(
    footer(dialog).getByRole('button', { name: 'Close issue', exact: true }),
  ).toBeVisible();
  await expect(
    footer(dialog).getByRole('button', { name: 'Close with a comment' }),
  ).toBeVisible();
  await expect(
    footer(dialog).getByRole('link', { name: /Open on GitHub/ }),
  ).toBeVisible();
});

test('Close asks to confirm, then closes and leaves the dialog open on Closed with Reopen focused', async ({
  page,
}) => {
  const { dialog, state } = await start(page);
  await footer(dialog).getByRole('button', { name: 'Close issue' }).click();
  expect(state.posted).toEqual([]);
  await footer(dialog)
    .getByRole('button', { name: 'Confirm close issue?' })
    .click();

  const reopen = footer(dialog).getByRole('button', { name: 'Reopen issue' });
  await expect(reopen).toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.details-state')).toContainText('Closed');
  await expect(dialog.locator('.details-closed')).toHaveText(
    'Closed. Reopen it if that was a mistake.',
  );
  expect(state.posted).toEqual([
    {
      path: 'close',
      body: {
        forge: 'github',
        fullName: 'alrayyes/forge-dashboard',
        number: 7,
      },
    },
  ]);
  await expect(
    footer(dialog).getByRole('button', { name: 'Close issue' }),
  ).toHaveCount(0);
});

test('Escape drops an unconfirmed Close without closing the dialog', async ({
  page,
}) => {
  const { dialog, state } = await start(page);
  await footer(dialog).getByRole('button', { name: 'Close issue' }).click();
  await expect(
    footer(dialog).getByRole('button', { name: 'Confirm close issue?' }),
  ).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(dialog).toBeVisible();
  await expect(
    footer(dialog).getByRole('button', { name: 'Close issue' }),
  ).toBeFocused();
  expect(state.posted).toEqual([]);
});

test('Reopen is the undo: it posts the reopen and the header says Open again', async ({
  page,
}) => {
  const { dialog, state } = await start(page);
  await footer(dialog).getByRole('button', { name: 'Close issue' }).click();
  await footer(dialog)
    .getByRole('button', { name: 'Confirm close issue?' })
    .click();
  await footer(dialog).getByRole('button', { name: 'Reopen issue' }).click();

  await expect(dialog.locator('.details-state')).toContainText('Open');
  await expect(
    footer(dialog).getByRole('button', { name: 'Close issue' }),
  ).toBeVisible();
  expect(state.posted.map((p) => p.path)).toEqual(['close', 'reopen']);
});

test('Close with a comment posts the comment, then closes', async ({
  page,
}) => {
  const { dialog, state } = await start(page);
  await footer(dialog)
    .getByRole('button', { name: 'Close with a comment' })
    .click();
  const field = dialog.getByRole('textbox', { name: 'Comment' });
  await expect(field).toBeFocused();
  await field.fill('Fixed in the last release.');
  await dialog.getByRole('button', { name: 'Comment and close' }).click();

  await expect(
    footer(dialog).getByRole('button', { name: 'Reopen issue' }),
  ).toBeFocused();
  await expect(dialog.locator('.details-state')).toContainText('Closed');
  expect(state.posted).toEqual([
    {
      path: 'comment',
      body: {
        forge: 'github',
        fullName: 'alrayyes/forge-dashboard',
        number: 7,
        body: 'Fixed in the last release.',
      },
    },
    {
      path: 'close',
      body: {
        forge: 'github',
        fullName: 'alrayyes/forge-dashboard',
        number: 7,
      },
    },
  ]);
});

test('a blank comment cannot be sent', async ({ page }) => {
  const { dialog, state } = await start(page);
  await footer(dialog)
    .getByRole('button', { name: 'Close with a comment' })
    .click();
  await dialog.getByRole('textbox', { name: 'Comment' }).fill('   ');
  await dialog.getByRole('button', { name: 'Comment and close' }).click();

  await expect(dialog.locator('.details-feedback')).toContainText(
    'Write a comment first',
  );
  expect(state.posted).toEqual([]);
});

test('Escape in the comment field closes the field, not the dialog', async ({
  page,
}) => {
  const { dialog } = await start(page);
  await footer(dialog)
    .getByRole('button', { name: 'Close with a comment' })
    .click();
  await page.keyboard.press('Escape');

  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Comment' })).toHaveCount(0);
});

test('a comment that posted but a close that failed says which half happened and retries only the close', async ({
  page,
}) => {
  const { dialog, state } = await start(page, {
    close: [
      { status: 502, body: { code: 'forge_error', message: 'Bad gateway.' } },
    ],
  });
  await footer(dialog)
    .getByRole('button', { name: 'Close with a comment' })
    .click();
  await dialog.getByRole('textbox', { name: 'Comment' }).fill('Done.');
  await dialog.getByRole('button', { name: 'Comment and close' }).click();

  await expect(dialog.locator('.details-feedback')).toContainText(
    'Your comment was posted. The issue is still open.',
  );
  const retry = footer(dialog).getByRole('button', { name: 'Retry close' });
  await expect(retry).toBeVisible();
  await expect(
    footer(dialog).getByRole('button', { name: 'Retry comment' }),
  ).toHaveCount(0);
  await retry.click();

  await expect(
    footer(dialog).getByRole('button', { name: 'Reopen issue' }),
  ).toBeVisible();
  expect(state.posted.map((p) => p.path)).toEqual([
    'comment',
    'close',
    'close',
  ]);
});

test('a comment that failed posts nothing and retries the comment', async ({
  page,
}) => {
  const { dialog, state } = await start(page, {
    comment: [
      { status: 502, body: { code: 'forge_error', message: 'Bad gateway.' } },
    ],
  });
  await footer(dialog)
    .getByRole('button', { name: 'Close with a comment' })
    .click();
  await dialog.getByRole('textbox', { name: 'Comment' }).fill('Done.');
  await dialog.getByRole('button', { name: 'Comment and close' }).click();

  await expect(dialog.locator('.details-feedback')).toContainText(
    'Your comment was not posted. The issue is still open.',
  );
  await footer(dialog).getByRole('button', { name: 'Retry comment' }).click();

  await expect(
    footer(dialog).getByRole('button', { name: 'Reopen issue' }),
  ).toBeVisible();
  expect(state.posted.map((p) => p.path)).toEqual([
    'comment',
    'comment',
    'close',
  ]);
});

test('a refused permission locks the buttons and prints the reason', async ({
  page,
}) => {
  const reason =
    'Changing an issue needs write access to issues: give the token Issues (Read and write).';
  const { dialog } = await start(page, {
    close: [{ status: 403, body: { code: 'permission', message: reason } }],
  });
  await footer(dialog).getByRole('button', { name: 'Close issue' }).click();
  await footer(dialog)
    .getByRole('button', { name: 'Confirm close issue?' })
    .click();

  const locked = footer(dialog).getByRole('button', { name: 'Close issue' });
  await expect(locked).toHaveAttribute('aria-disabled', 'true');
  await expect(
    footer(dialog).getByRole('button', { name: 'Close with a comment' }),
  ).toHaveAttribute('aria-disabled', 'true');
  await expect(footer(dialog)).toContainText(reason);
  await expect(locked).toHaveAccessibleDescription(reason);
});

test('a spent rate limit locks the buttons with the reset time', async ({
  page,
}) => {
  const { dialog } = await start(page, {
    close: [
      {
        status: 429,
        body: {
          code: 'rate_limited',
          message: 'Limit reached.',
          resetsAt: new Date(Date.now() + 600_000).toISOString(),
        },
      },
    ],
  });
  await footer(dialog).getByRole('button', { name: 'Close issue' }).click();
  await footer(dialog)
    .getByRole('button', { name: 'Confirm close issue?' })
    .click();

  await expect(
    footer(dialog).getByRole('button', { name: 'Close issue' }),
  ).toHaveAttribute('aria-disabled', 'true');
  await expect(footer(dialog)).toContainText('rate limit');
});

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`has no axe violations in the footer, the comment field and the closed state in ${scheme} at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      const { dialog } = await start(page);
      await expectNoViolations(page);

      await footer(dialog)
        .getByRole('button', { name: 'Close with a comment' })
        .click();
      await expect(
        dialog.getByRole('textbox', { name: 'Comment' }),
      ).toBeVisible();
      await expectNoViolations(page);

      await dialog.getByRole('textbox', { name: 'Comment' }).fill('Done.');
      await dialog.getByRole('button', { name: 'Comment and close' }).click();
      await expect(dialog.locator('.details-closed')).toBeVisible();
      await expectNoViolations(page);
    });
  }
}
