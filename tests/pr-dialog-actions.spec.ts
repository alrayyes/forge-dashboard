import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { openActionsDialog } from './actions-dialog-helper';
import { test } from './server-fixture';

// The details dialog's footer carries every action its row offers: the
// primary one first, Close last, a locked one drawn greyed with its reason as
// text. Mocks /api/v1/dashboard, the details endpoint and the action endpoints
// only.

type Entry = {
  action: string;
  primary?: boolean;
  blocked?: { code: string; message: string; next?: string };
};

const now = new Date().toISOString();

function makePR(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

function snapshot(
  prs: Record<string, unknown>[],
  forges: Record<string, unknown>[] = [
    { forge: 'github', reachable: true, repoCount: 1 },
  ],
) {
  return {
    generatedAt: new Date().toISOString(),
    forges,
    pullRequests: prs,
    issues: [],
    repos: [],
    hiddenDrafts: 0,
  };
}

type Posted = { url: string; body: Record<string, unknown> };

// Serves the board from `current`, records every action POST and answers it
// with `answers[path]` (204 unless a spec says otherwise).
async function start(
  page: Page,
  prs: Record<string, unknown>[],
  answers: Record<string, { status: number; body?: unknown }> = {},
  forges?: Record<string, unknown>[],
) {
  const state = {
    current: prs,
    posted: [] as Posted[],
    description: 'The description.',
    detailsCalls: 0,
  };
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
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  for (const glob of ['**/api/v1/dashboard*', '**/api/v1/dashboard/refresh*'])
    await page.route(glob, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(state.current, forges)),
      }),
    );
  await page.route('**/api/v1/pull-requests/details*', (route: Route) => {
    state.detailsCalls++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: state.description,
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
    });
  });
  await page.route(/\/api\/v1\/pull-requests\/[a-z-]+(\/cancel)?$/, (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'POST') return route.fallback();
    state.posted.push({
      url: url.pathname,
      body: route.request().postDataJSON(),
    });
    const answer = answers[url.pathname] ?? { status: 204 };
    // The server keeps an accepted branch update on the pull request until
    // a later fetch shows it caught up, so the next snapshot carries it.
    // Without it the page reads the refresh as "finished" and says so a
    // second time, whenever the refresh lands more than 30 ms after the
    // first line.
    if (
      url.pathname === '/api/v1/pull-requests/update-branch' &&
      answer.status < 300
    ) {
      const body = route.request().postDataJSON();
      const now = Date.now();
      state.current = state.current.map((pr) =>
        pr.number === body.number && pr.repo === body.fullName
          ? {
              ...pr,
              updateRequest: {
                phase: 'queued',
                requestedAt: new Date(now).toISOString(),
                expiresAt: new Date(now + 5 * 60_000).toISOString(),
              },
            }
          : pr,
      );
    }
    return route.fulfill({
      status: answer.status,
      contentType: 'application/json',
      body: answer.body === undefined ? '' : JSON.stringify(answer.body),
    });
  });
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows .row')).toHaveCount(prs.length);
  return state;
}

async function push(page: Page, prs: Record<string, unknown>[]) {
  await page.evaluate(
    (data) => {
      const w = window as unknown as { __streams: EventSource[] };
      for (const stream of w.__streams)
        stream.onmessage?.(new MessageEvent('message', { data }));
    },
    JSON.stringify(snapshot(prs)),
  );
}

const row = (page: Page) => page.locator('#pr-rows .row').first();
const footer = (dialog: Locator) => dialog.locator('.details-footer');
const footerButtons = (dialog: Locator) =>
  footer(dialog).locator('.details-actions button');

async function names(buttons: Locator) {
  return (await buttons.allInnerTexts()).map((t) => t.trim());
}

test.describe('the dialog footer offers every action of the row (every type)', () => {
  // [action, button, endpoint, extra PR fields, steps before the request]
  const cases: {
    action: string;
    button: string;
    path: string;
    pr?: Record<string, unknown>;
    confirm?: string;
    body?: Record<string, unknown>;
  }[] = [
    {
      action: 'merge',
      button: 'Merge',
      path: '/api/v1/pull-requests/merge',
      confirm: 'Confirm merge?',
    },
    {
      action: 'close',
      button: 'Close pull request',
      path: '/api/v1/pull-requests/close',
      confirm: 'Confirm close pull request?',
    },
    {
      action: 'update_branch',
      button: 'Update branch',
      path: '/api/v1/pull-requests/update-branch',
      pr: { behind: true },
    },
    {
      action: 'auto_merge',
      button: 'Enable auto-merge',
      path: '/api/v1/pull-requests/auto-merge',
    },
    {
      action: 'cancel_auto_merge',
      button: 'Cancel auto-merge',
      path: '/api/v1/pull-requests/auto-merge/cancel',
    },
    {
      action: 'dependabot_rebase',
      button: 'Dependabot: Rebase',
      path: '/api/v1/pull-requests/dependabot-action',
      body: { action: 'rebase' },
    },
    {
      action: 'dependabot_recreate',
      button: 'Dependabot: Recreate',
      path: '/api/v1/pull-requests/dependabot-action',
      body: { action: 'recreate' },
      confirm: 'Confirm recreate?',
    },
    {
      action: 'renovate_rebase',
      button: 'Renovate: Rebase',
      path: '/api/v1/pull-requests/renovate-rebase',
    },
    {
      action: 'rerun_checks',
      button: 'Rerun failed checks',
      path: '/api/v1/pull-requests/rerun-checks',
      pr: { ci: 'failure' },
    },
  ];

  for (const c of cases) {
    test(`${c.action}: the footer offers "${c.button}" and sends the row's request`, async ({
      page,
    }) => {
      const state = await start(page, [
        makePR({
          ...c.pr,
          allowedActions: [{ action: c.action }],
        }),
      ]);
      const dialog = await openActionsDialog(row(page));
      const button = footer(dialog).getByRole('button', {
        name: c.button,
        exact: true,
      });
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();

      await button.click();
      if (c.confirm)
        await footer(dialog)
          .getByRole('button', { name: c.confirm, exact: true })
          .click();

      await expect.poll(() => state.posted.length).toBe(1);
      expect(state.posted[0].url).toBe(c.path);
      expect(state.posted[0].body).toMatchObject({
        forge: 'github',
        fullName: 'alrayyes/forge-dashboard',
        number: 42,
        ...c.body,
      });
    });
  }
});

test.describe('the footer order', () => {
  const offered: Entry[] = [
    { action: 'close' },
    { action: 'auto_merge' },
    { action: 'update_branch' },
    { action: 'merge', primary: true },
  ];

  test('the primary action comes first and Close last, on the right', async ({
    page,
  }) => {
    await start(page, [makePR({ behind: true, allowedActions: offered })]);
    const dialog = await openActionsDialog(row(page));
    const list = await names(footerButtons(dialog));
    expect(list[0]).toBe('Merge');
    expect(list[list.length - 1]).toBe('Close pull request');
    expect(list).toEqual(
      expect.arrayContaining(['Update branch', 'Enable auto-merge']),
    );

    const boxes = await footerButtons(dialog).evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect().right),
    );
    expect(boxes[boxes.length - 1]).toBe(Math.max(...boxes));
  });

  test('without a primary, the others keep their order and Close stays last', async ({
    page,
  }) => {
    await start(page, [
      makePR({
        behind: true,
        allowedActions: [
          { action: 'close' },
          { action: 'update_branch' },
          { action: 'auto_merge' },
        ],
      }),
    ]);
    const dialog = await openActionsDialog(row(page));
    const list = await names(footerButtons(dialog));
    expect(list[list.length - 1]).toBe('Close pull request');
  });

  test('"Open on GitHub" stays in the footer', async ({ page }) => {
    await start(page, [makePR()]);
    const dialog = await openActionsDialog(row(page));
    await expect(
      footer(dialog).getByRole('link', { name: /Open on GitHub/ }),
    ).toHaveAttribute('href', 'https://example.com/42');
  });
});

test.describe('a locked action', () => {
  const reason = 'Waiting for CI to finish';
  const next = 'Merge unlocks automatically';
  const blockedMerge = {
    action: 'merge',
    blocked: { code: 'checks_pending', message: reason, next },
  };

  test('Merge stays drawn greyed with its reason as text, described to screen readers', async ({
    page,
  }) => {
    const state = await start(page, [
      makePR({
        ci: 'pending',
        allowedActions: [blockedMerge, { action: 'close' }],
        status: { code: 'checks_pending', message: reason, next },
      }),
    ]);
    const dialog = await openActionsDialog(row(page));
    const merge = footer(dialog).getByRole('button', {
      name: 'Merge',
      exact: true,
    });
    await expect(merge).toHaveAttribute('aria-disabled', 'true');
    await expect(merge).toHaveAccessibleDescription(new RegExp(reason));
    // The reason is on the page as words, not behind a hover.
    await expect(dialog.locator('.status-area')).toContainText(reason);
    await expect(dialog.locator('.status-area')).toBeVisible();

    // aria-disabled, so a click is allowed to land and must do nothing.
    await merge.click({ force: true });
    await expect(
      footer(dialog).getByRole('button', { name: /Confirm merge/ }),
    ).toHaveCount(0);
    expect(state.posted).toEqual([]);
  });

  test('"Rerun failed checks" on a Forgejo with no rerun route stays greyed, with the reason', async ({
    page,
  }) => {
    const why =
      'This Forgejo is older than version 17 and has no way to rerun checks. Rerun them on the forge.';
    const state = await start(
      page,
      [
        makePR({
          forge: 'forgejo',
          ci: 'failure',
          allowedActions: [{ action: 'rerun_checks' }],
        }),
      ],
      {},
      [
        {
          forge: 'forgejo',
          reachable: true,
          repoCount: 1,
          rerunChecksBlocked: why,
        },
      ],
    );
    const dialog = await openActionsDialog(row(page));
    const rerun = footer(dialog).getByRole('button', {
      name: 'Rerun failed checks',
      exact: true,
    });

    await expect(rerun).toHaveAttribute('aria-disabled', 'true');
    await expect(rerun).toHaveAccessibleDescription(new RegExp(why));
    await rerun.click({ force: true });
    expect(state.posted).toEqual([]);
  });

  test('a locked action with no status block still says why beside it', async ({
    page,
  }) => {
    await start(page, [
      makePR({ ci: 'pending', status: null, allowedActions: [blockedMerge] }),
    ]);
    const dialog = await openActionsDialog(row(page));
    const merge = footer(dialog).getByRole('button', {
      name: 'Merge',
      exact: true,
    });
    await expect(merge).toHaveAccessibleDescription(new RegExp(reason));
    await expect(footer(dialog)).toContainText(reason);
  });
});

test.describe('confirming Close in the footer', () => {
  test('the first click only arms it, Escape backs out and keeps the dialog', async ({
    page,
  }) => {
    const state = await start(page, [makePR()]);
    const dialog = await openActionsDialog(row(page));
    await footer(dialog)
      .getByRole('button', { name: 'Close pull request' })
      .click();

    const confirm = footer(dialog).getByRole('button', {
      name: 'Confirm close pull request?',
    });
    await expect(confirm).toBeFocused();
    await expect(
      footer(dialog).getByRole('button', { name: 'Cancel' }),
    ).toBeVisible();
    expect(state.posted).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(confirm).toHaveCount(0);
    await expect(
      footer(dialog).getByRole('button', { name: 'Close pull request' }),
    ).toBeFocused();

    // A second Escape closes the dialog, as it always did.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(state.posted).toEqual([]);
  });

  test('Cancel backs out and Confirm sends the close', async ({ page }) => {
    const state = await start(page, [makePR()]);
    const dialog = await openActionsDialog(row(page));
    const close = footer(dialog).getByRole('button', {
      name: 'Close pull request',
    });
    await close.click();
    await footer(dialog).getByRole('button', { name: 'Cancel' }).click();
    await expect(close).toBeVisible();
    expect(state.posted).toEqual([]);

    await close.click();
    await footer(dialog)
      .getByRole('button', { name: 'Confirm close pull request?' })
      .click();
    await expect.poll(() => state.posted.length).toBe(1);
  });

  test('Merge has the same confirm step', async ({ page }) => {
    const state = await start(page, [makePR()]);
    const dialog = await openActionsDialog(row(page));
    await footer(dialog)
      .getByRole('button', { name: 'Merge', exact: true })
      .click();
    await expect(
      footer(dialog).getByRole('button', { name: 'Confirm merge?' }),
    ).toBeFocused();
    expect(state.posted).toEqual([]);
  });
});

test.describe('a failure in the dialog', () => {
  test('shows a line above the footer and leaves the footer usable', async ({
    page,
  }) => {
    const state = await start(
      page,
      [
        makePR({
          behind: true,
          allowedActions: [
            { action: 'update_branch', primary: true },
            { action: 'close' },
          ],
        }),
      ],
      {
        '/api/v1/pull-requests/update-branch': {
          status: 500,
          body: {
            error: 'dashboard: update pull request: POST /repos/x/y: 500',
          },
        },
      },
    );
    const dialog = await openActionsDialog(row(page));
    await footer(dialog)
      .getByRole('button', { name: 'Update branch', exact: true })
      .click();

    const line = dialog.locator('.details-feedback .row-feedback-line');
    await expect(line).toContainText('Failed');
    // Above the footer, never raw error text.
    const lineBox = await line.boundingBox();
    const footerBox = await footer(dialog).boundingBox();
    expect(lineBox && footerBox && lineBox.y < footerBox.y).toBe(true);
    await expect(dialog).not.toContainText('POST /repos');

    // The footer still works: the same request goes out again.
    const again = footer(dialog).getByRole('button', {
      name: 'Update branch',
      exact: true,
    });
    await expect(again).toBeEnabled();
    await again.click();
    await expect.poll(() => state.posted.length).toBe(2);

    await line.getByRole('button', { name: /^Dismiss/ }).click();
    await expect(line).toHaveCount(0);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('actions keep the order, 44px targets, a sticky footer and wrapped status text', async ({
    page,
  }) => {
    const long =
      'Waiting for the required checks on this branch to finish before the forge allows a merge';
    await start(page, [
      makePR({
        behind: true,
        ci: 'pending',
        allowedActions: [
          {
            action: 'merge',
            blocked: { code: 'checks_pending', message: long },
          },
          { action: 'update_branch' },
          { action: 'auto_merge' },
          { action: 'close' },
        ],
        status: { code: 'checks_pending', message: long },
      }),
    ]);
    const dialog = await openActionsDialog(row(page));
    const buttons = footerButtons(dialog);
    const list = await names(buttons);
    expect(list[0]).toBe('Merge');
    expect(list[list.length - 1]).toBe('Close pull request');

    const boxes = await buttons.evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { w: r.width, h: r.height, right: r.right, left: r.left };
      }),
    );
    for (const b of boxes) {
      expect(b.h).toBeGreaterThanOrEqual(44);
      expect(b.w).toBeGreaterThanOrEqual(44);
      expect(b.right).toBeLessThanOrEqual(390);
      expect(b.left).toBeGreaterThanOrEqual(0);
    }

    // A sheet: full height, footer pinned to its bottom edge.
    const sheet = await dialog.boundingBox();
    const foot = await footer(dialog).boundingBox();
    expect(sheet?.height).toBeGreaterThanOrEqual(790);
    expect((foot?.y ?? 0) + (foot?.height ?? 0)).toBeGreaterThanOrEqual(
      (sheet?.y ?? 0) + (sheet?.height ?? 0) - 2,
    );

    // The status text wraps, whole.
    const status = dialog.locator('.status-area-message');
    await expect(status).toHaveText(long);
    const overflow = await status.evaluate(
      (e) => e.scrollWidth > e.clientWidth + 1,
    );
    expect(overflow).toBe(false);
    const noScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noScroll).toBe(true);
  });
});

test.describe('ids and focus', () => {
  test('the dialog repeats no id the row has', async ({ page }) => {
    await start(page, [
      makePR({
        behind: true,
        ci: 'pending',
        status: { code: 'checks_pending', message: 'Waiting for CI' },
        allowedActions: [
          {
            action: 'merge',
            blocked: { code: 'checks_pending', message: 'Waiting for CI' },
          },
          { action: 'close' },
        ],
      }),
    ]);
    const dialog = await openActionsDialog(row(page));
    // Armed too, so the confirm ids are on the page twice over.
    await footer(dialog)
      .getByRole('button', { name: 'Close pull request' })
      .click();
    const dupes = await page.evaluate(() => {
      const seen = new Map<string, number>();
      for (const e of document.querySelectorAll('[id]'))
        seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
      return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    });
    expect(dupes).toEqual([]);
  });

  test('every aria-describedby in the dialog points at an element in it', async ({
    page,
  }) => {
    await start(page, [
      makePR({
        ci: 'pending',
        status: { code: 'checks_pending', message: 'Waiting for CI' },
        allowedActions: [
          {
            action: 'merge',
            blocked: { code: 'checks_pending', message: 'Waiting for CI' },
          },
        ],
      }),
    ]);
    const dialog = await openActionsDialog(row(page));
    const missing = await dialog.evaluate((d) =>
      [...d.querySelectorAll('[aria-describedby]')]
        .flatMap((e) => (e.getAttribute('aria-describedby') ?? '').split(' '))
        .filter((id) => !d.querySelector(`#${CSS.escape(id)}`)),
    );
    expect(missing).toEqual([]);
  });

  test('focus returns to the row when the dialog closes', async ({ page }) => {
    await start(page, [makePR()]);
    const dialog = await openActionsDialog(row(page));
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(
      row(page).getByRole('button', { name: /^#42 / }),
    ).toBeFocused();
  });

  test('after an action completes the footer redraws and focus stays inside', async ({
    page,
  }) => {
    const state = await start(page, [
      makePR({
        behind: true,
        allowedActions: [
          { action: 'update_branch', primary: true },
          { action: 'close' },
        ],
      }),
    ]);
    const dialog = await openActionsDialog(row(page));
    await footer(dialog)
      .getByRole('button', { name: 'Update branch', exact: true })
      .click();
    await expect.poll(() => state.posted.length).toBe(1);
    // The footer was drawn again; focus is still on a control in the dialog,
    // not dropped to the page.
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest('dialog') !== null),
      )
      .toBe(true);
  });
});

test.describe('the footer follows its pull request', () => {
  test('a poll that changes allowedActions redraws the open footer', async ({
    page,
  }) => {
    const before = makePR({
      behind: true,
      allowedActions: [
        { action: 'update_branch', primary: true },
        { action: 'close' },
      ],
    });
    await start(page, [before]);
    const dialog = await openActionsDialog(row(page));
    await expect(
      footer(dialog).getByRole('button', { name: 'Update branch' }),
    ).toBeVisible();

    await push(page, [
      makePR({
        behind: false,
        allowedActions: [
          { action: 'merge', primary: true },
          { action: 'close' },
        ],
      }),
    ]);
    await expect(
      footer(dialog).getByRole('button', { name: 'Update branch' }),
    ).toHaveCount(0);
    expect((await names(footerButtons(dialog)))[0]).toBe('Merge');
    await expect(dialog).toBeVisible();
  });

  test('a merged pull request closes the dialog', async ({ page }) => {
    const state = await start(page, [makePR()]);
    const dialog = await openActionsDialog(row(page));
    await footer(dialog)
      .getByRole('button', { name: 'Merge', exact: true })
      .click();
    state.current = [];
    await footer(dialog)
      .getByRole('button', { name: 'Confirm merge?' })
      .click();
    await expect(dialog).toBeHidden();
  });

  test('a new snapshot of the open pull request fetches its details again', async ({
    page,
  }) => {
    const state = await start(page, [makePR()]);
    const dialog = await openActionsDialog(row(page));
    await expect(dialog).toContainText('The description.');
    expect(state.detailsCalls).toBe(1);
    state.description = 'The new description.';
    await push(page, [
      makePR({ updatedAt: new Date(Date.now() + 60_000).toISOString() }),
    ]);
    await expect(dialog).toContainText('The new description.');
    await expect(dialog.getByText('Loading details')).toHaveCount(0);
    expect(state.detailsCalls).toBe(2);
  });

  test('a snapshot that changes another pull request leaves the details alone', async ({
    page,
  }) => {
    const state = await start(page, [
      makePR(),
      makePR({ number: 43, title: 'Other' }),
    ]);
    const dialog = await openActionsDialog(row(page));
    await expect(dialog).toContainText('The description.');
    await push(page, [
      makePR(),
      makePR({ number: 43, title: 'Other', ci: 'failure' }),
    ]);
    await expect(page.locator('#pr-rows .row').nth(1)).toContainText('Failed');
    expect(state.detailsCalls).toBe(1);
  });
});

// Contrast of two rgb() strings, from the page's own computed values.
const contrast = (page: Page, fg: string, bg: string) =>
  page.evaluate(
    ([a, b]) => {
      const parse = (c: string) =>
        (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = (c: string) => {
        const [r, g, bl] = parse(c).map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      };
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    },
    [fg, bg],
  );

for (const scheme of ['light', 'dark'] as const) {
  test(`a locked action looks locked next to a live one (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const next = 'Merge unlocks automatically';
    await start(page, [
      makePR({
        ci: 'pending',
        behind: true,
        status: {
          code: 'checks_pending',
          message: 'Waiting for CI to finish',
          next,
        },
        allowedActions: [
          {
            action: 'merge',
            blocked: {
              code: 'checks_pending',
              message: 'Waiting for CI to finish',
              next,
            },
          },
          { action: 'update_branch' },
          { action: 'close' },
        ],
      }),
    ]);
    const dialog = await openActionsDialog(row(page));
    const style = (b: Locator) =>
      b.evaluate((e) => {
        const c = getComputedStyle(e);
        return {
          color: c.color,
          background: c.backgroundColor,
          border: c.borderTopStyle,
        };
      });
    const locked = await style(
      footer(dialog).getByRole('button', { name: 'Merge', exact: true }),
    );
    const live = await style(
      footer(dialog).getByRole('button', {
        name: 'Update branch',
        exact: true,
      }),
    );
    expect(locked).not.toEqual(live);
    expect(locked.border).not.toBe(live.border);
    expect(locked.background).not.toBe(live.color);

    // The reason is readable text: 4.5:1 or better against what is behind it.
    for (const sel of ['.status-area-message', '.status-area-next']) {
      const colours = await dialog.locator(sel).evaluate((e) => {
        let bg: HTMLElement | null = e as HTMLElement;
        while (
          bg &&
          getComputedStyle(bg).backgroundColor === 'rgba(0, 0, 0, 0)'
        )
          bg = bg.parentElement;
        return {
          fg: getComputedStyle(e).color,
          bg: bg ? getComputedStyle(bg).backgroundColor : 'rgb(255, 255, 255)',
        };
      });
      expect(
        await contrast(page, colours.fg, colours.bg),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test.describe('what is said to a screen reader inside the dialog', () => {
  // Counts every non-empty text the dialog's own live region, or the page's
  // hide status, is given.
  async function listen(page: Page) {
    await page.evaluate(() => {
      const w = window as unknown as { __said: string[] };
      w.__said = [];
      const watch = (el: Element | null) => {
        if (!el) return;
        new MutationObserver(() => {
          const t = (el.textContent ?? '').trim();
          if (t) w.__said.push(t);
        }).observe(el, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      };
      watch(document.querySelector('dialog.details-dialog > [role="status"]'));
      watch(document.getElementById('hide-status'));
    });
  }
  const said = (page: Page) =>
    page.evaluate(() => (window as unknown as { __said: string[] }).__said);

  test('the dialog has its own live region from the first paint', async ({
    page,
  }) => {
    await start(page, [makePR()]);
    await expect(
      page.locator(
        'dialog.details-dialog > [role="status"][aria-live="polite"]',
      ),
    ).toHaveCount(1);
  });

  test('a successful action is said once', async ({ page }) => {
    await start(page, [
      makePR({
        behind: true,
        allowedActions: [{ action: 'update_branch', primary: true }],
      }),
    ]);
    const dialog = await openActionsDialog(row(page));
    await listen(page);
    await footer(dialog)
      .getByRole('button', { name: 'Update branch', exact: true })
      .click();
    await expect.poll(() => said(page)).toHaveLength(1);
    await page.waitForTimeout(500);
    expect(await said(page)).toHaveLength(1);
  });

  test('a failed action is said once, and shown as a line', async ({
    page,
  }) => {
    await start(
      page,
      [
        makePR({
          behind: true,
          allowedActions: [{ action: 'update_branch', primary: true }],
        }),
      ],
      {
        '/api/v1/pull-requests/update-branch': {
          status: 500,
          body: { error: 'raw' },
        },
      },
    );
    const dialog = await openActionsDialog(row(page));
    await listen(page);
    await footer(dialog)
      .getByRole('button', { name: 'Update branch', exact: true })
      .click();
    await expect(dialog.locator('.row-feedback-line')).toContainText('Failed');
    await expect.poll(() => said(page)).toHaveLength(1);
    await page.waitForTimeout(500);
    expect(await said(page)).toHaveLength(1);
  });

  test('Hide closes the dialog, says so once and puts focus on Undo', async ({
    page,
  }) => {
    const state = await start(page, [makePR()]);
    const dialog = await openActionsDialog(row(page));
    await listen(page);
    state.current = [];
    await footer(dialog)
      .getByRole('button', { name: 'Hide this pull request' })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeFocused();
    await page.waitForTimeout(500);
    expect(await said(page)).toHaveLength(1);
    expect((await said(page))[0]).toMatch(/Hid /);
  });

  test('a Hide that fails stays in the dialog as a line, said once', async ({
    page,
  }) => {
    await start(page, [makePR()], {
      '/api/v1/pull-requests/hide': { status: 500, body: { error: 'raw' } },
    });
    const dialog = await openActionsDialog(row(page));
    await listen(page);
    await footer(dialog)
      .getByRole('button', { name: 'Hide this pull request' })
      .click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.row-feedback-line')).toContainText(/hide/i);
    await expect.poll(() => said(page)).toHaveLength(1);
  });
});

test.describe('the footer across rebuilds', () => {
  test('focus stays on the same button when a poll changes the footer', async ({
    page,
  }) => {
    await start(page, [
      makePR({
        allowedActions: [
          { action: 'merge', primary: true },
          { action: 'auto_merge' },
          { action: 'close' },
        ],
      }),
    ]);
    const dialog = await openActionsDialog(row(page));
    const auto = footer(dialog).getByRole('button', {
      name: 'Enable auto-merge',
    });
    await auto.focus();
    await push(page, [
      makePR({
        behind: true,
        allowedActions: [
          { action: 'merge', primary: true },
          { action: 'update_branch' },
          { action: 'auto_merge' },
          { action: 'close' },
        ],
      }),
    ]);
    await expect(
      footer(dialog).getByRole('button', { name: 'Update branch' }),
    ).toBeVisible();
    await expect(auto).toBeFocused();
  });

  test('a poll during an armed confirm neither disarms nor double-submits', async ({
    page,
  }) => {
    const state = await start(page, [makePR()]);
    const dialog = await openActionsDialog(row(page));
    await footer(dialog)
      .getByRole('button', { name: 'Close pull request' })
      .click();
    const confirm = footer(dialog).getByRole('button', {
      name: 'Confirm close pull request?',
    });
    await expect(confirm).toBeFocused();
    await push(page, [makePR({ ci: 'pending' })]);
    await push(page, [makePR({ ci: 'failure' })]);
    await expect(confirm).toBeVisible();
    await expect(confirm).toBeFocused();
    expect(state.posted).toEqual([]);
    await confirm.click();
    await expect.poll(() => state.posted.length).toBe(1);
    await page.waitForTimeout(300);
    expect(state.posted.length).toBe(1);
  });

  test('the footer comes back when a later snapshot has the pull request again', async ({
    page,
  }) => {
    await start(page, [makePR()]);
    const dialog = await openActionsDialog(row(page));
    await push(page, []);
    await expect(dialog.locator('.details-gone')).toBeVisible();
    await push(page, [makePR()]);
    await expect(dialog.locator('.details-gone')).toHaveCount(0);
    await expect(
      footer(dialog).getByRole('button', { name: 'Close pull request' }),
    ).toBeVisible();
  });
});

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`has no axe-core violations in the open dialog (${scheme}, ${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await start(
        page,
        [
          makePR({
            behind: true,
            ci: 'pending',
            status: {
              code: 'checks_pending',
              message: 'Waiting for CI to finish',
              next: 'Merge unlocks automatically',
            },
            allowedActions: [
              {
                action: 'merge',
                blocked: {
                  code: 'checks_pending',
                  message: 'Waiting for CI to finish',
                  next: 'Merge unlocks automatically',
                },
              },
              { action: 'update_branch', primary: false },
              { action: 'auto_merge' },
              { action: 'close' },
            ],
          }),
        ],
        {
          '/api/v1/pull-requests/update-branch': {
            status: 500,
            body: { error: 'raw' },
          },
        },
      );
      const dialog = await openActionsDialog(row(page));
      await footer(dialog)
        .getByRole('button', { name: 'Update branch', exact: true })
        .click();
      await expect(
        dialog.locator('.details-feedback .row-feedback-line'),
      ).toContainText('Failed');
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
