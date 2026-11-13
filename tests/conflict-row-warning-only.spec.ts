import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import { test } from './server-fixture';

// A confirmed conflict draws its warning and nothing it contradicts: no locked
// Merge, no locked Update branch, no Out of date chip. An unconfirmed Forgejo
// conflict keeps a live Update branch, a behind row with a live Update branch
// drops the chip, and the pop-up footer still lists every action with its
// reason. The Out of date quick filter keeps reading `behind`.
// https://github.com/alrayyes/forge-dashboard/issues/3770

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'forgejo',
    repo: 'example/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'someone',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: true,
    kind: 'regular',
    ...overrides,
  };
}

async function open(
  page: Page,
  width: number,
  prs: unknown[],
  path = '/pull-requests.html',
) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
        pullRequests: prs,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(path);
  await expect(page.locator('#pr-rows > .row')).toHaveCount(prs.length);
}

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title });

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

const PRS = [
  pr(1, {
    title: 'Refused with conflict',
    mergeStatus: 'conflicting',
    conflictConfirmed: true,
  }),
  pr(2, {
    title: 'Flag only conflict',
    mergeStatus: 'conflicting',
    conflictConfirmed: false,
    // The stand-in has no unconfirmed axis, so the mock says what the server
    // does: Update branch stays live, since updating is how it finds out.
    allowedActions: [
      {
        action: 'merge',
        blocked: {
          code: 'conflict',
          message: 'Merge conflict.',
          next: 'Resolve it on the forge to unlock Merge',
        },
      },
      { action: 'update_branch' },
      { action: 'close' },
    ],
  }),
  pr(3, { title: 'Plain behind' }),
  pr(4, { title: 'Up to date', behind: false }),
];

for (const width of [360, 390, 1280]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, width, PRS);
    });

    test('AC1: a confirmed conflict shows the warning and no Merge, Update branch or Out of date', async ({
      page,
    }) => {
      const r = row(page, 'Refused with conflict');
      await expect(r.locator('.merge-pill')).toHaveText('Conflicting');
      await expect(r.locator('.status-area')).toContainText('Merge conflict');
      await expect(
        r.getByRole('button', { name: 'Merge', exact: true }),
      ).toHaveCount(0);
      await expect(
        r.getByRole('button', { name: 'Update branch' }),
      ).toHaveCount(0);
      await expect(r.locator('.attr-chip.behind')).toHaveCount(0);
      expect((await axe(page)).violations).toEqual([]);
    });

    test('AC2: a behind row with a live Update branch has no Out of date chip', async ({
      page,
    }) => {
      const r = row(page, 'Plain behind');
      const update = r.getByRole('button', { name: 'Update branch' });
      await expect(update).toHaveCount(1);
      await expect(update).not.toHaveAttribute('aria-disabled', 'true');
      await expect(r.locator('.attr-chip.behind')).toHaveCount(0);
      expect((await axe(page)).violations).toEqual([]);
    });

    test('AC3: an unconfirmed conflict shows its pill and a live Update branch', async ({
      page,
    }) => {
      const r = row(page, 'Flag only conflict');
      await expect(
        r.getByRole('button', { name: 'Conflict not confirmed' }),
      ).toBeVisible();
      const update = r.getByRole('button', { name: 'Update branch' });
      await expect(update).toHaveCount(1);
      await expect(update).not.toHaveAttribute('aria-disabled', 'true');
      await expect(r.locator('.attr-chip.behind')).toHaveCount(0);
    });
  });
}

test('a confirmed conflict on an empty pull request keeps its Close', async ({
  page,
}) => {
  await open(page, 390, [
    pr(7, { title: 'Empty conflict', mergeStatus: 'conflicting', empty: true }),
  ]);
  await expect(
    row(page, 'Empty conflict').getByRole('button', {
      name: 'Close pull request',
    }),
  ).toHaveCount(1);
});

test('a confirmed conflict on a Renovate pull request keeps the cancel of a pending rebase', async ({
  page,
}) => {
  await open(
    page,
    390,
    [
      pr(8, {
        title: 'Renovate conflict',
        author: 'renovate[bot]',
        kind: 'dependency',
        mergeStatus: 'conflicting',
        conflictConfirmed: true,
        allowedActions: [
          { action: 'cancel_renovate_rebase' },
          { action: 'close' },
        ],
        status: null,
      }),
    ],
    '/bots.html',
  );
  await expect(
    row(page, 'Renovate conflict').getByRole('button', {
      name: 'Cancel Renovate rebase',
    }),
  ).toHaveCount(1);
});

test('AC4: a conflicting pull request pop-up footer still lists Merge and Update branch locked with reasons', async ({
  page,
}) => {
  await open(page, 1280, PRS);
  await row(page, 'Refused with conflict')
    .getByRole('button', { name: /^#1 / })
    .click();
  const dialog = page.locator('dialog[open]');
  const merge = dialog.getByRole('button', { name: 'Merge', exact: true });
  const update = dialog.getByRole('button', { name: 'Update branch' });
  await expect(merge).toHaveAttribute('aria-disabled', 'true');
  await expect(update).toHaveAttribute('aria-disabled', 'true');
  await expect(dialog).toContainText('Conflicts need fixing by hand');
  expect((await axe(page)).violations).toEqual([]);
});

test('AC5: the Out of date quick filter still keeps every behind pull request', async ({
  page,
}) => {
  await open(page, 1280, PRS);
  await page.getByRole('button', { name: /^Out of date/ }).click();
  await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
  await expect(row(page, 'Up to date')).toHaveCount(0);
});

// A Merge already confirming or running keeps its place on the row when a
// snapshot reports a confirmed conflict, so its progress doesn't vanish. The
// board holds its rows while a row action is in flight, except the pull request
// whose details dialog is open, which takes the fresh data where it stands. So
// the Merge is started from that dialog.
// Without the phase check in conflictWarnsAlone the warning would replace it.
// https://github.com/alrayyes/forge-dashboard/issues/3787
test.describe('a Merge in progress when a conflict appears', () => {
  const mergeable = () => pr(9, { title: 'Conflict arrives', behind: false });
  const conflicted = () =>
    pr(9, {
      title: 'Conflict arrives',
      behind: false,
      mergeStatus: 'conflicting',
      conflictConfirmed: true,
    });

  // The row keeps its action instead of the warning alone. The server now
  // locks Merge, so the action is the locked Merge button; the Merging chip
  // beside it is the running state.
  const lockedMerge = (r: Locator) =>
    r.getByRole('button', { name: 'Merge', exact: true });

  // The live stream, held open until `push` is called, then carrying a
  // snapshot with the conflict. `held` resolves once the page is listening.
  async function conflictOnTheStream(page: Page) {
    let push: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      push = resolve;
    });
    let listening: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      listening = resolve;
    });
    let served = false;
    await page.route('**/api/v1/dashboard/stream*', async (route: Route) => {
      if (served) {
        return route.fulfill({ status: 404, json: { error: 'done' } });
      }
      listening();
      await gate;
      served = true;
      const snapshot = {
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
        pullRequests: [conflicted()],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      };
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify(snapshot)}\n\n`,
      });
    });
    return { held, push };
  }

  for (const width of [360, 390, 1280]) {
    test(`AC1: a confirming Merge keeps its row action when a conflict appears at ${width}px`, async ({
      page,
    }) => {
      await open(page, width, [mergeable()]);
      const stream = await conflictOnTheStream(page);
      const r = row(page, 'Conflict arrives');
      const dialog = await openActionsDialog(r);
      await stream.held;
      await actionsFooter(dialog)
        .getByRole('button', { name: 'Merge', exact: true })
        .click();
      await expect(
        r.getByRole('button', { name: 'Confirm merge?' }),
      ).toBeVisible();

      stream.push();

      await expect(r.locator('.merge-pill')).toHaveText('Conflicting');
      await expect(lockedMerge(r)).toHaveAttribute('aria-disabled', 'true');
      expect((await axe(page)).violations).toEqual([]);
    });

    test(`AC2: a running Merge keeps its Merging state and row action until the request settles at ${width}px`, async ({
      page,
    }) => {
      await open(page, width, [mergeable()]);
      const stream = await conflictOnTheStream(page);
      let release: () => void = () => {};
      const settle = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(
        '**/api/v1/pull-requests/merge',
        async (route: Route) => {
          await settle;
          return route.fulfill({ status: 204 });
        },
      );
      const r = row(page, 'Conflict arrives');
      const dialog = await openActionsDialog(r);
      await stream.held;
      const footer = actionsFooter(dialog);
      await footer.getByRole('button', { name: 'Merge', exact: true }).click();
      await footer.getByRole('button', { name: 'Confirm merge?' }).click();
      await expect(r.locator('.wait-chip-label')).toHaveText('Merging');

      stream.push();

      await expect(r.locator('.merge-pill')).toHaveText('Conflicting');
      await expect(r.locator('.wait-chip-label')).toHaveText('Merging');
      await expect(lockedMerge(r)).toHaveAttribute('aria-disabled', 'true');
      expect((await axe(page)).violations).toEqual([]);

      release();
      await expect(r.locator('.wait-chip-label')).toHaveCount(0);
    });
  }
});
