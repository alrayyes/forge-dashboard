import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// #3279: Disarm, Cancel auto-merge and Enable auto-merge kept a native
// `disabled` while their request ran, which drops keyboard focus to BODY. Each
// stays focusable (aria-disabled) and focus lands somewhere sensible after.
// Focus is sampled at four points: f0 before the press, f1 while the request
// is pending, f2 at the reply, f3 once the board settled.

const now = new Date().toISOString();

const ARMED = {
  autoMergeEnabled: true,
  ci: 'pending',
  mergeStatus: 'blocked',
  autoMerge: {
    state: 'waiting',
    code: 'checks_pending',
    message: 'Auto-merge is waiting for checks to finish.',
  },
  allowedActions: [
    { action: 'merge' },
    { action: 'close' },
    { action: 'cancel_auto_merge' },
  ],
};

const IDLE = {
  autoMergeEnabled: false,
  allowedActions: [
    { action: 'merge', primary: true },
    { action: 'close' },
    { action: 'auto_merge' },
  ],
};

function makePR(overrides: Record<string, unknown>) {
  return {
    forge: 'forgejo',
    repo: 'alrayyes/dotfiles',
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
    ...overrides,
  };
}

type Sample = { tag: string; text: string; id: string; inDialog: boolean };

const sample = (page: Page): Promise<Sample> =>
  page.evaluate(() => {
    const a = document.activeElement;
    return {
      tag: a?.tagName ?? '',
      text: (a?.textContent ?? '').trim(),
      id: a?.id ?? '',
      inDialog: a?.closest('dialog') != null,
    };
  });

type Scenario = {
  name: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  endpoint: string;
  label: RegExp;
  pending: RegExp;
  inDialog: boolean;
};

const scenarios: Scenario[] = [
  {
    name: 'row Disarm',
    before: ARMED,
    after: IDLE,
    endpoint: '/api/v1/pull-requests/auto-merge/cancel',
    label: /^Disarm$/,
    pending: /^Disarming…$/,
    inDialog: false,
  },
  {
    name: 'dialog Cancel auto-merge',
    before: ARMED,
    after: IDLE,
    endpoint: '/api/v1/pull-requests/auto-merge/cancel',
    label: /^Cancel auto-merge$/,
    pending: /^Cancelling…$/,
    inDialog: true,
  },
  {
    name: 'dialog Enable auto-merge',
    before: IDLE,
    after: ARMED,
    endpoint: '/api/v1/pull-requests/auto-merge',
    label: /^Enable auto-merge$/,
    pending: /^Enabling…$/,
    inDialog: true,
  },
];

for (const sc of scenarios) {
  for (const status of [204, 429]) {
    test(`${sc.name} keeps focus while the request runs, reply ${status}`, async ({
      page,
    }) => {
      let current = makePR(sc.before);
      const posted: unknown[] = [];
      let replied = false;
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
      for (const glob of [
        '**/api/v1/dashboard*',
        '**/api/v1/dashboard/refresh*',
      ])
        await page.route(glob, (route: Route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              generatedAt: new Date().toISOString(),
              forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
              pullRequests: [current],
              issues: [],
              openIssueCount: 0,
              navCounts: navCountsFor([current], 0),
            }),
          }),
        );
      await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            description: {
              text: 'The description.',
              format: 'markdown',
              truncated: false,
              edited: false,
              reactions: {
                thumbsUp: { count: 0, logins: [] },
                thumbsDown: { count: 0, logins: [] },
              },
            },
            comments: [],
            commentCount: 0,
            commentsTruncated: false,
            releaseNotes: null,
          }),
        }),
      );
      await page.route(`**${sc.endpoint}`, async (route: Route) => {
        posted.push(route.request().postDataJSON());
        await gate;
        replied = true;
        if (status === 204) {
          current = makePR(sc.after);
          return route.fulfill({ status: 204 });
        }
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'rate limit exceeded',
            code: 'rate_limited',
            message: "The forge's API rate limit is reached. Try again later.",
          }),
        });
      });
      await page.goto('/pull-requests.html');
      const row = page.locator('#pr-rows .row').first();
      await expect(row).toBeVisible();

      let scope: Locator = row;
      if (sc.inDialog) {
        scope = actionsFooter(await openActionsDialog(row));
      }
      const button = scope.locator('button').filter({ hasText: sc.label });
      await button.focus();
      const f0 = await sample(page);

      await page.keyboard.press('Enter');
      await expect.poll(() => posted.length).toBe(1);
      const f1 = await sample(page);
      expect(f1.tag, JSON.stringify({ f0, f1 })).not.toBe('BODY');
      // A second Enter while the first runs sends nothing. On the row it goes
      // to the chip that stands in for Disarm, which has no action of its own.
      await page.keyboard.press('Enter');

      release();
      // f2 is taken once the route has answered, not at a fixed delay.
      await expect.poll(() => replied).toBe(true);
      const f2 = await sample(page);
      // Settled: the pending label is gone, and on a 204 so is the pressed
      // button, which the reply replaced or removed.
      await expect(
        scope.locator('button').filter({ hasText: sc.pending }),
      ).toHaveCount(0);
      if (status === 204)
        await expect(
          scope.locator('button').filter({ hasText: sc.label }),
        ).toHaveCount(0);
      else
        await expect(
          scope.locator('button').filter({ hasText: sc.label }),
        ).toBeVisible();
      const f3 = await sample(page);
      const trace = JSON.stringify({ f0, f1, f2, f3 });

      expect(f0.text, trace).toMatch(sc.label);
      for (const s of [f0, f1, f2, f3]) expect(s.tag, trace).not.toBe('BODY');
      // The row's Disarm sits in a chip the row hides while the request runs
      // (a chip saying "Disarming" stands in), so focus is on that chip.
      expect(f1.text, trace).toMatch(/Disarming|Cancelling…|Enabling…/);
      expect(posted).toHaveLength(1);
      if (status === 429) {
        // A rate limit locks the button (aria-disabled, with its reason), but
        // it stays in place and focused.
        expect(f3.text, trace).toMatch(sc.label);
      } else if (sc.inDialog) {
        expect(f3.inDialog, trace).toBe(true);
      } else {
        // AC2: the row's title button, never BODY.
        expect(f3.id, trace).toMatch(/^details-trigger-/);
      }
    });
  }
}

// The merge and close confirm buttons: pending is aria-disabled, which a press
// still reaches, so the confirm handler ignores it. Enter, Enter, Space sends
// one request, and focus is never on BODY.
for (const kind of ['merge', 'close'] as const) {
  test(`${kind} confirm sends one request for Enter, Enter, Space and keeps focus`, async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    const current = makePR(IDLE);
    const posted: unknown[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
    for (const glob of ['**/api/v1/dashboard*', '**/api/v1/dashboard/refresh*'])
      await page.route(glob, (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
            pullRequests: [current],
            issues: [],
            openIssueCount: 0,
            navCounts: navCountsFor([current], 0),
          }),
        }),
      );
    await page.route(
      `**/api/v1/pull-requests/${kind}`,
      async (route: Route) => {
        posted.push(route.request().postDataJSON());
        await gate;
        return route.fulfill({ status: 204 });
      },
    );
    await page.goto('/pull-requests.html');
    const row = page.locator('#pr-rows .row').first();
    await expect(row).toBeVisible();

    let scope: Locator = row;
    let arm: Locator;
    let confirmName: string;
    if (kind === 'merge') {
      arm = row.getByRole('button', { name: 'Merge', exact: true });
      confirmName = 'Confirm merge?';
    } else {
      scope = actionsFooter(await openActionsDialog(row));
      arm = scope.getByRole('button', {
        name: 'Close pull request',
        exact: true,
      });
      confirmName = 'Confirm close pull request?';
    }
    await arm.click();
    const confirm = scope.getByRole('button', { name: confirmName });
    await expect(confirm).toBeVisible();
    // Past the 400ms double-click guard, on the page's own clock.
    await page.clock.fastForward(500);
    await confirm.focus();
    const f0 = await sample(page);

    await page.keyboard.press('Enter');
    await expect.poll(() => posted.length).toBe(1);
    const f1 = await sample(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    // The label changes while it runs, so find the same button by its class.
    const pending = scope.locator('button.row-action.confirm');
    await expect(pending).toHaveAttribute('aria-disabled', 'true');
    await expect(pending).not.toHaveAttribute('disabled', /.*/);

    release();
    await expect(pending).toHaveCount(0);
    const f3 = await sample(page);
    const trace = JSON.stringify({ f0, f1, f3 });
    expect(posted, trace).toHaveLength(1);
    for (const s of [f0, f1, f3]) expect(s.tag, trace).not.toBe('BODY');
  });
}
