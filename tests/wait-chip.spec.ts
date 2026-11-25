import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import { type Forge, forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #1229: every "something is happening, hold on" state on a pull request
// row is one chip in the row's action area: an icon, a short label, a
// lighter line naming the actor or the reason, and a button only where one
// exists. These journeys play the server by mocking snapshots; the wording
// itself is checked without a browser in web/src/lib/wait-chip.test.ts.

// The slot takes room only while a chip is in it (#4502, #4590): a phone card
// with no chip is no taller than its content, and grows by at most the chip's
// room (CHIP_ROOM) when the user's own tap makes one appear.
test.use({ viewport: { width: 390, height: 844 } });

type MockPR = Record<string, unknown>;

function makePR(overrides: MockPR = {}): MockPR {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    ...overrides,
  };
}

const botPR = (author: string) =>
  makePR({ author, behind: true, mergeStatus: 'blocked' });

function snapshot(pr: MockPR) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [forgeHealth(pr.forge as Forge)],
    pullRequests: [pr],
    issues: [],
  };
}

function botRequest(phase: string, requestedAgoMs = 0) {
  const at = Date.now() - requestedAgoMs;
  return {
    bot: 'dependabot',
    action: 'rebase',
    phase,
    requestedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 5 * 60_000).toISOString(),
  };
}

// The page needs a hand on the live stream and on Date.now: one pushes a
// snapshot as the server would, the other makes two minutes pass at once.
async function installHooks(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __skew: number;
      __streams: EventSource[];
      EventSource: typeof EventSource;
    };
    w.__skew = 0;
    const real = Date.now.bind(Date);
    Date.now = () => real() + w.__skew;
    w.__streams = [];
    const Real = w.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        w.__streams.push(this);
      }
    };
  });
}

async function push(page: Page, pr: MockPR) {
  await page.evaluate(
    (data) => {
      const w = window as unknown as { __streams: EventSource[] };
      for (const stream of w.__streams)
        stream.onmessage?.(new MessageEvent('message', { data }));
    },
    JSON.stringify(snapshot(pr)),
  );
}

async function skew(page: Page, ms: number) {
  await page.evaluate((v) => {
    (window as unknown as { __skew: number }).__skew = v;
  }, ms);
}

const firstRow = (page: Page) => page.locator('#pr-rows .row').first();
const chipOf = (page: Page) => firstRow(page).locator('.wait-chip');
// The chip's room is the status cell's: an empty slot is not drawn and holds
// no place (#4590).
const slotOf = (page: Page) => firstRow(page).locator('.status-cell');

// The chip's 59px slot and the flex gap above it.
const CHIP_ROOM = 65;

async function size(locator: Locator) {
  // A snapshot can rebuild the row between finding it and measuring it, so
  // wait for a box rather than measuring once.
  let size = { width: 0, height: 0 };
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      if (box) size = { width: box.width, height: box.height };
      return box !== null;
    })
    .toBe(true);
  return size;
}

// What must not move when a chip comes or goes: the row, and the area the
// chip sits in.
async function layout(page: Page) {
  return {
    row: await size(firstRow(page)),
    // Width only: the cell grows by the chip's room when one arrives and
    // shrinks again when it goes (#4590).
    slot: { width: (await size(slotOf(page))).width },
  };
}

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const OLD_TEXT =
  /Awaiting the next refresh|Waiting for Dependabot|Waiting for Renovate|will pick this up shortly|Waiting for CI to restart|Requested \d+s ago/;

async function bots(page: Page, pr: MockPR, current: () => MockPR) {
  await installHooks(page);
  await page.route('**/api/v1/settings/bot-pr-updates', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowBotPrUpdates: false }),
    }),
  );
  const answer = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(current())),
    });
  await page.route('**/api/v1/dashboard*', answer);
  await page.route('**/api/v1/dashboard/refresh', answer);
  void pr;
}

test.describe('the waiting chip on a bot rebase', () => {
  let current: MockPR;

  test.beforeEach(async ({ page }) => {
    current = botPR('dependabot');
    // Before the hooks, so the skew sits on top of the fake clock's Date.now.
    await page.clock.install();
    await bots(page, current, () => current);
    await page.route(
      '**/api/v1/pull-requests/dependabot-action',
      (route: Route) => {
        current = { ...current, botRequest: botRequest('queued') };
        return route.fulfill({ status: 204 });
      },
    );
    await page.goto('/bots.html');
  });

  async function ask(page: Page) {
    await firstRow(page)
      .getByRole('button', { name: 'Dependabot: Rebase' })
      .click();
    await expect(chipOf(page)).toBeVisible();
    // The request has been accepted before a test moves the clock, so the
    // acceptance can't land later and count as a change.
    await expect(page.locator('#feedback-toasts')).toContainText(
      'rebase requested.',
    );
  }

  test('a requested rebase is one chip with the bot and its age, and the card grows by at most the chip', async ({
    page,
  }) => {
    await expect(slotOf(page)).toBeVisible();
    await expect(chipOf(page)).toHaveCount(0);
    const before = await layout(page);

    await ask(page);

    const chip = chipOf(page);
    await expect(chip.locator('.wait-chip-label')).toHaveText(
      'Rebase requested',
    );
    await expect(chip.locator('.wait-chip-detail')).toContainText('Dependabot');
    const ago = chip.locator('.feedback-requested');
    await expect(ago).toHaveAttribute('aria-hidden', 'true');
    await expect(ago).toHaveText('0s ago');
    await skew(page, 7_000);
    await expect(ago).toHaveText('7s ago');

    // The chip takes its own room and no more: the card grows by at most
    // that, downwards (#4590).
    const after = await layout(page);
    expect(after.slot).toEqual(before.slot);
    expect(after.row.height).toBeLessThanOrEqual(before.row.height + CHIP_ROOM);
    // No way out is offered, so no button.
    await expect(chip.getByRole('button')).toHaveCount(0);
    await expect(firstRow(page)).not.toContainText(OLD_TEXT);
    await expect(firstRow(page).locator('.row-feedback')).toHaveCount(0);
  });

  test('picked up, then settled, then gone: each change is announced once, the clearing is silent, and the card shrinks back', async ({
    page,
  }) => {
    const before = await layout(page);
    await ask(page);
    const live = page.locator('#feedback-live');
    await expect(live).toContainText('Dependabot rebase requested.');

    current = {
      ...current,
      behind: false,
      botRequest: botRequest('rebasing'),
    };
    await push(page, current);
    await expect(chipOf(page).locator('.wait-chip-label')).toHaveText(
      'Rebasing',
    );
    await expect(live).toHaveText(/Dependabot picked up the rebase\./);
    // The snapshot itself changed here (no longer behind), so only the
    // chip's own area is held to its size.
    expect((await layout(page)).slot).toEqual(before.slot);
    const oneLine = (await size(chipOf(page))).height;

    current = { ...current, ci: 'pending', botRequest: undefined };
    await push(page, current);
    // The row also waits on CI now, but its own chip steps out while the
    // Settled one stands in for it: one chip label on the row at a time.
    const settledChip = chipOf(page).filter({ hasText: 'Settled' });
    await expect(settledChip).toHaveCount(1);
    await expect(chipOf(page)).toHaveCount(1);
    await expect(live).toHaveText(/Dependabot rebase finished\./);
    const settled = await layout(page);
    expect(settled.slot).toEqual(before.slot);
    // One line, and the row no taller than the room the chip takes (#4663).
    expect((await size(chipOf(page))).height).toBeLessThanOrEqual(oneLine + 1);
    expect(settled.row.height).toBeLessThanOrEqual(
      before.row.height + CHIP_ROOM,
    );
    const spoken = await live.textContent();

    // The settled chip clears by itself, and says nothing as it goes. The
    // row's own CI chip stays, since CI is still running (#4663).
    await expect(settledChip).toHaveCount(0, { timeout: 10_000 });
    expect(await live.textContent()).toBe(spoken);
    await expect(chipOf(page).locator('.wait-chip-label')).toHaveText(
      'Waiting for CI',
    );
    // It takes its room with it: the card is as wide and no taller.
    const gone = await layout(page);
    expect(gone.slot).toEqual(settled.slot);
    expect(gone.row.height).toBeLessThanOrEqual(settled.row.height);
  });

  test('two minutes with no change reads Still waiting, announced once, and Check again refetches the row', async ({
    page,
  }) => {
    await ask(page);
    const live = page.locator('#feedback-live');

    let refreshes = 0;
    await page.route('**/api/v1/dashboard/refresh', (route: Route) => {
      refreshes += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(current)),
      });
    });
    const before = await layout(page);
    await skew(page, 121_000);

    const chip = chipOf(page);
    await expect(chip.locator('.wait-chip-label')).toHaveText('Still waiting');
    await expect(live).toContainText('Still waiting');
    const spoken = await live.textContent();
    // Two and a half seconds on the page's own timers, without waiting them.
    await page.clock.runFor(2500);
    expect(await live.textContent()).toBe(spoken);
    expect(await layout(page)).toEqual(before);

    await chip.getByRole('button', { name: 'Check again' }).click();
    await expect.poll(() => refreshes).toBeGreaterThan(0);

    // The bot moves: the chip follows.
    current = { ...current, behind: false, botRequest: botRequest('rebasing') };
    await push(page, current);
    await expect(chipOf(page).locator('.wait-chip-label')).toHaveText(
      'Rebasing',
    );
  });

  test('the explanation opens on keyboard focus and on hover', async ({
    page,
  }) => {
    await ask(page);
    // The click left the pointer where the chip now is.
    await page.mouse.move(0, 0);
    const chip = chipOf(page);
    // The row draws no button for the request, so the click's focus moved to
    // the chip; leave it so the tip starts closed.
    await chip.evaluate((e) => (e as HTMLElement).blur());
    const tip = chip.locator('.wait-chip-tip');
    await expect(tip).toHaveCSS('opacity', '0');

    await chip.focus();
    await expect(tip).toHaveCSS('opacity', '1');
    await expect(tip).toContainText('Dependabot');
    await expect(chip).toHaveAccessibleDescription(/Dependabot/);

    await page.locator('h1, header').first().click();
    await expect(tip).toHaveCSS('opacity', '0');
    await chip.hover();
    await expect(tip).toHaveCSS('opacity', '1');
  });

  test('reduced motion makes the spinner a static icon', async ({ page }) => {
    await ask(page);
    const spinner = chipOf(page).locator('.wait-chip-spinner');
    await expect(spinner).toHaveCSS('animation-name', /spin/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(spinner).toHaveCSS('animation-name', 'none');
  });

  test('on a phone the chip sits in the card, the page does not widen, and the button is 44px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ask(page);
    await skew(page, 121_000);
    const button = chipOf(page).getByRole('button', { name: 'Check again' });
    await expect(button).toBeVisible();

    const row = await firstRow(page).boundingBox();
    const chip = await chipOf(page).boundingBox();
    const target = await button.boundingBox();
    if (!row || !chip || !target) throw new Error('no box');
    expect(chip.x).toBeGreaterThanOrEqual(row.x);
    expect(chip.x + chip.width).toBeLessThanOrEqual(row.x + row.width);
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.width).toBeGreaterThanOrEqual(44);
    await noOverflow(page);
  });

  test('has no axe violations while waiting, still waiting and settled, in both themes', async ({
    page,
  }) => {
    // The chip only moves forward (waiting, still waiting, settled), so each
    // state is scanned in both themes before the next one.
    const scan = async () => {
      for (const scheme of ['light', 'dark'] as const) {
        await test.step(scheme, async () => {
          await page.emulateMedia({ colorScheme: scheme });
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
          expect(results.violations).toEqual([]);
        });
      }
    };
    await ask(page);
    await test.step('waiting', scan);

    await skew(page, 121_000);
    await expect(chipOf(page).locator('.wait-chip-label')).toHaveText(
      'Still waiting',
    );
    await test.step('still waiting', scan);

    await skew(page, 0);
    current = { ...current, behind: false, botRequest: undefined };
    await push(page, current);
    await expect(chipOf(page).locator('.wait-chip-label')).toHaveText(
      'Settled',
    );
    await test.step('settled', scan);
  });
});

test.describe('the waiting chip on Update branch', () => {
  test('Updating branch counts down to the refresh, with no layout shift and no old line', async ({
    page,
  }) => {
    const pr = makePR({ behind: true, mergeStatus: 'blocked' });
    let accepted = false;
    const served = () =>
      accepted
        ? {
            ...pr,
            updateRequest: {
              phase: 'queued',
              requestedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            },
          }
        : pr;
    const answer = (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(served())),
      });
    await page.route('**/api/v1/dashboard*', answer);
    await page.route('**/api/v1/dashboard/refresh', answer);
    await page.route(
      '**/api/v1/pull-requests/update-branch',
      (route: Route) => {
        accepted = true;
        return route.fulfill({ status: 202 });
      },
    );
    await page.goto('/pull-requests.html');

    const before = await layout(page);
    await firstRow(page).getByRole('button', { name: 'Update branch' }).click();

    const chip = chipOf(page);
    await expect(chip.locator('.wait-chip-label')).toHaveText(
      'Updating branch',
    );
    await expect(chip.locator('.feedback-countdown')).toContainText(
      /refresh in \d+s/i,
    );
    await expect(chip.locator('.feedback-countdown')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    await expect(page.locator('#feedback-live')).toHaveText(
      /Branch update requested\./,
    );
    await expect(page.locator('#feedback-live')).not.toContainText(
      /Awaiting the next refresh/,
    );
    // The button's label changed too (Update branch to Queued…), which can
    // re-flow the cell by itself, so the chip's own part is measured: the row
    // with the chip taken out and with it back.
    const withChip = await layout(page);
    await chip.evaluate((el) => {
      (el as HTMLElement).style.display = 'none';
    });
    expect(await layout(page)).toEqual(withChip);
    await chip.evaluate((el) => {
      (el as HTMLElement).style.display = '';
    });
    expect(withChip.slot).toEqual(before.slot);
    await expect(firstRow(page)).not.toContainText(OLD_TEXT);
    await expect(chip.getByRole('button')).toHaveCount(0);
  });
});

test.describe('the waiting chip on a merge and a close', () => {
  for (const s of [
    {
      name: 'Merge',
      button: 'Merge',
      endpoint: 'merge',
      label: 'Merging',
      confirm: 'Confirm merge?',
    },
    {
      name: 'Close',
      button: 'Close pull request',
      endpoint: 'close',
      label: 'Closing',
      confirm: 'Confirm close pull request?',
    },
  ]) {
    test(`${s.name} in progress is a ${s.label} chip, and the card grows by at most the chip`, async ({
      page,
    }) => {
      const answer = (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot(makePR())),
        });
      await page.route('**/api/v1/dashboard*', answer);
      await page.route('**/api/v1/dashboard/refresh', answer);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(
        `**/api/v1/pull-requests/${s.endpoint}`,
        async (route) => {
          await gate;
          return route.fulfill({ status: 204 });
        },
      );
      await page.goto('/pull-requests.html');

      const row = firstRow(page);
      // Close is in the row's dialog, with the Hide items (#841).
      const scope =
        s.endpoint === 'close'
          ? actionsFooter(await openActionsDialog(row))
          : row;
      await scope.getByRole('button', { name: s.button, exact: true }).click();
      const confirm = scope.getByRole('button', { name: s.confirm });
      await expect(confirm).toBeVisible();
      const before = await layout(page);
      await confirm.click();

      await expect(chipOf(page).locator('.wait-chip-label')).toHaveText(
        s.label,
      );
      await expect(chipOf(page).getByRole('button')).toHaveCount(0);
      const after = await layout(page);
      // The row is as wide as before and grows by at most the chip's room
      // (#4590). It may grow less for Merge, whose confirm group (a longer
      // "Confirm close pull request?" wraps) leaves the row.
      expect(after.slot).toEqual(before.slot);
      expect(after.row.width).toBe(before.row.width);
      expect(after.row.height).toBeLessThanOrEqual(
        before.row.height + CHIP_ROOM,
      );
      release();
    });
  }
});

test.describe('the waiting chip on Forgejo auto-merge', () => {
  const armed = (overrides: MockPR = {}) =>
    makePR({
      forge: 'forgejo',
      repo: 'alrayyes/dotfiles',
      number: 7,
      ci: 'pending',
      mergeStatus: 'blocked',
      autoMergeEnabled: true,
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
      ...overrides,
    });

  async function open(page: Page, pr: MockPR) {
    await page.route('**/api/v1/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(pr)),
      }),
    );
    await page.goto('/pull-requests.html');
  }

  test('an armed pull request reads Waiting for CI, with Cancel auto-merge in the chip and the reason in the tooltip', async ({
    page,
  }) => {
    await open(page, armed());
    const chip = chipOf(page);
    await expect(chip.locator('.wait-chip-label')).toHaveText('Waiting for CI');
    // One line: the second sentence repeated the label (#4663).
    await expect(chip.locator('.wait-chip-detail')).toBeHidden();
    await expect(chip.locator('.wait-chip-tip')).toHaveText(
      'Auto-merge is waiting for checks to finish.',
    );
    await expect(
      chip.getByRole('button', { name: 'Cancel auto-merge' }),
    ).toBeVisible();
    await expect(firstRow(page).locator('.auto-merge-status')).toHaveCount(0);
    await expect(firstRow(page)).not.toContainText('Waiting:');
  });

  test('the action area is at most one chip taller armed than not', async ({
    page,
  }) => {
    await open(page, makePR({ forge: 'forgejo', repo: 'alrayyes/dotfiles' }));
    await expect(slotOf(page)).toBeVisible();
    const plain = await size(slotOf(page));
    await page.unroute('**/api/v1/dashboard*');
    await open(page, armed());
    await expect(chipOf(page)).toBeVisible();
    // The chip takes the room the action had, so the area grows by at most
    // the chip's room (#4590).
    expect((await size(slotOf(page))).height).toBeLessThanOrEqual(
      plain.height + CHIP_ROOM,
    );
  });

  test('Cancel auto-merge posts for that pull request', async ({ page }) => {
    let posted: unknown = null;
    await page.route(
      '**/api/v1/pull-requests/auto-merge/cancel',
      (route: Route) => {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      },
    );
    await page.route('**/api/v1/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          snapshot(makePR({ forge: 'forgejo', repo: 'alrayyes/dotfiles' })),
        ),
      }),
    );
    await open(page, armed());
    await chipOf(page)
      .getByRole('button', { name: 'Cancel auto-merge' })
      .click();
    await expect
      .poll(() => posted)
      .toEqual({
        forge: 'forgejo',
        fullName: 'alrayyes/dotfiles',
        number: 7,
      });
  });

  test('a stopped auto-merge is not a wait: the phone card keeps its text line and shows no chip (#4601)', async ({
    page,
  }) => {
    await open(
      page,
      armed({
        autoMerge: {
          state: 'stopped',
          code: 'checks_failing',
          message: 'Auto-merge stopped: a check failed.',
        },
      }),
    );
    await expect(chipOf(page)).toBeHidden();
    await expect(firstRow(page).locator('.auto-merge-status')).toBeVisible();
    await expect(firstRow(page).locator('.auto-merge-status')).toContainText(
      'Stopped',
    );
  });

  test('has no axe violations with the chip, in both themes', async ({
    page,
  }) => {
    await open(page, armed());
    await expect(chipOf(page)).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await test.step(scheme, async () => {
        await page.emulateMedia({ colorScheme: scheme });
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  });
});

test.describe('the waiting chip on an action queued for a reset (#756)', () => {
  const queuedItem = (runAt: string) => ({
    id: 'q1',
    action: 'update_branch',
    forge: 'github',
    fullName: 'alrayyes/forge-dashboard',
    number: 42,
    status: 'queued',
    runAt,
    createdAt: new Date().toISOString(),
  });

  test('is one Queued chip with the reset time, Cancel inside, and the chip fills the status cell width', async ({
    page,
  }) => {
    const pr = makePR({ behind: true, mergeStatus: 'blocked' });
    let queued: ReturnType<typeof queuedItem> | null = null;
    await page.route('**/api/v1/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...snapshot({ ...pr, queued }),
          queuedActions: queued ? [queued] : [],
        }),
      }),
    );
    const deletes: string[] = [];
    await page.route('**/api/v1/queued-actions/*', (route: Route) => {
      deletes.push(route.request().url().split('/').pop() ?? '');
      return route.fulfill({ status: 204 });
    });
    await page.goto('/pull-requests.html');
    await expect(slotOf(page)).toBeVisible();
    const plain = await size(slotOf(page));

    queued = queuedItem(new Date(Date.now() + 8 * 60_000).toISOString());
    await page.goto('/pull-requests.html');

    const chip = chipOf(page);
    await expect(chip.locator('.wait-chip-label')).toHaveText(
      /^Queued · \d{1,2}:\d{2}$/,
    );
    const resets = chip.locator('.wait-chip-detail');
    await expect(resets).toContainText(/Resets in [78]m/);
    await expect(resets.locator('[aria-hidden="true"]')).toHaveCount(1);
    const withChip = await size(slotOf(page));
    expect(withChip.width).toEqual(plain.width);
    expect(withChip.height).toBeLessThanOrEqual(plain.height + CHIP_ROOM);

    await chip
      .getByRole('button', {
        name: 'Cancel queued update for alrayyes/forge-dashboard#42',
      })
      .click();
    await expect.poll(() => deletes).toEqual(['q1']);
  });
});

// #1293: GitHub's own auto-merge reads like Forgejo's, with the same chip and
// a Cancel auto-merge that goes to GitHub through the same endpoint.
test.describe('the waiting chip on GitHub auto-merge', () => {
  const armed = (overrides: MockPR = {}) =>
    makePR({
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 9,
      ci: 'pending',
      mergeStatus: 'blocked',
      autoMergeEnabled: true,
      autoMerge: {
        state: 'waiting',
        code: 'checks_pending',
        message: 'Auto-merge is on. GitHub merges it when the checks pass.',
      },
      allowedActions: [
        { action: 'merge' },
        { action: 'close' },
        { action: 'cancel_auto_merge' },
      ],
      ...overrides,
    });

  async function open(page: Page, pr: MockPR) {
    await page.route('**/api/v1/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(pr)),
      }),
    );
    await page.goto('/pull-requests.html');
  }

  test('an armed GitHub pull request reads Waiting for CI, with Cancel auto-merge in the chip', async ({
    page,
  }) => {
    await open(page, armed());
    const chip = chipOf(page);
    await expect(chip.locator('.wait-chip-label')).toHaveText('Waiting for CI');
    await expect(chip.locator('.wait-chip-tip')).toHaveText(
      'Auto-merge is on. GitHub merges it when the checks pass.',
    );
    await expect(
      chip.getByRole('button', { name: 'Cancel auto-merge' }),
    ).toBeVisible();
    await expect(firstRow(page).locator('.auto-merge-status')).toHaveCount(0);
  });

  test('Cancel auto-merge posts for that GitHub pull request', async ({
    page,
  }) => {
    let posted: unknown = null;
    await page.route(
      '**/api/v1/pull-requests/auto-merge/cancel',
      (route: Route) => {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      },
    );
    await page.route('**/api/v1/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          snapshot(
            makePR({ forge: 'github', repo: 'alrayyes/forge-dashboard' }),
          ),
        ),
      }),
    );
    await open(page, armed());
    await chipOf(page)
      .getByRole('button', { name: 'Cancel auto-merge' })
      .click();
    await expect
      .poll(() => posted)
      .toEqual({
        forge: 'github',
        fullName: 'alrayyes/forge-dashboard',
        number: 9,
      });
    await expect(chipOf(page)).toHaveCount(0);
  });

  test('a stopped GitHub auto-merge keeps its text line on the phone card and shows no chip (#4601)', async ({
    page,
  }) => {
    await open(
      page,
      armed({
        autoMerge: {
          state: 'stopped',
          code: 'checks_failing',
          message: 'Auto-merge is on, but a check failed.',
        },
      }),
    );
    await expect(chipOf(page)).toBeHidden();
    await expect(firstRow(page).locator('.auto-merge-status')).toBeVisible();
    await expect(firstRow(page).locator('.auto-merge-status')).toContainText(
      'Stopped',
    );
  });

  test('a GitHub pull request that is not armed has no chip', async ({
    page,
  }) => {
    await open(
      page,
      makePR({ forge: 'github', repo: 'alrayyes/forge-dashboard' }),
    );
    await expect(chipOf(page)).toHaveCount(0);
  });
});
