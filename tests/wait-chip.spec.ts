import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1229: every "something is happening, hold on" state on a pull request
// row is one chip in the row's action area: an icon, a short label, a
// lighter line naming the actor or the reason, and a button only where one
// exists. These journeys play the server by mocking snapshots; the wording
// itself is checked without a browser in wait-chip-unit.spec.ts.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `wait-chip-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Wait Chip User');
}

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
    forges: [{ forge: pr.forge as string, reachable: true, repoCount: 1 }],
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
const slotOf = (page: Page) => firstRow(page).locator('.wait-slot');

async function size(locator: Locator) {
  // A snapshot can rebuild the row between finding it and measuring it.
  for (let attempt = 0; attempt < 10; attempt++) {
    const box = await locator.boundingBox();
    if (box) return { width: box.width, height: box.height };
    await locator.page().waitForTimeout(100);
  }
  throw new Error('no box');
}

// What must not move when a chip comes or goes: the row, and the area the
// chip sits in.
async function layout(page: Page) {
  return {
    row: await size(firstRow(page)),
    slot: await size(slotOf(page)),
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
  await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
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
  await page.route('**/api/dashboard*', answer);
  await page.route('**/api/dashboard/refresh', answer);
  void pr;
}

test.describe('the waiting chip on a bot rebase', () => {
  let current: MockPR;

  test.beforeEach(async ({ page, request, baseURL }) => {
    current = botPR('dependabot');
    await registerAndSignIn(page, request, baseURL);
    await page.goto('/bots.html');
    await bots(page, current, () => current);
    await page.route(
      '**/api/pull-requests/dependabot-action',
      (route: Route) => {
        current = { ...current, botRequest: botRequest('queued') };
        return route.fulfill({ status: 204 });
      },
    );
    await page.reload();
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

  test('a requested rebase is one chip with the bot and its age, and the row does not move', async ({
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

    expect(await layout(page)).toEqual(before);
    // No way out is offered, so no button.
    await expect(chip.getByRole('button')).toHaveCount(0);
    await expect(firstRow(page)).not.toContainText(OLD_TEXT);
    await expect(firstRow(page).locator('.row-feedback')).toHaveCount(0);
  });

  test('picked up, then settled, then gone: each change is announced once, the clearing is silent, and nothing moves', async ({
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

    current = { ...current, ci: 'pending', botRequest: undefined };
    await push(page, current);
    await expect(chipOf(page).locator('.wait-chip-label')).toHaveText(
      'Settled',
    );
    await expect(live).toHaveText(/Dependabot rebase finished\./);
    const settled = await layout(page);
    expect(settled.slot).toEqual(before.slot);
    const spoken = await live.textContent();

    // The chip clears by itself, and says nothing as it goes.
    await expect(chipOf(page)).toHaveCount(0, { timeout: 10_000 });
    expect(await live.textContent()).toBe(spoken);
    // Same snapshot before and after the chip goes: nothing moves.
    expect(await layout(page)).toEqual(settled);
  });

  test('two minutes with no change reads Still waiting, announced once, and Check again refetches the row', async ({
    page,
  }) => {
    await ask(page);
    const live = page.locator('#feedback-live');

    let refreshes = 0;
    await page.route('**/api/dashboard/refresh', (route: Route) => {
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
    await page.waitForTimeout(2500);
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
    const chip = chipOf(page);
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

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe violations while waiting, still waiting and settled (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const scan = async () => {
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      };
      await ask(page);
      await scan();

      await skew(page, 121_000);
      await expect(chipOf(page).locator('.wait-chip-label')).toHaveText(
        'Still waiting',
      );
      await scan();

      await skew(page, 0);
      current = { ...current, behind: false, botRequest: undefined };
      await push(page, current);
      await expect(chipOf(page).locator('.wait-chip-label')).toHaveText(
        'Settled',
      );
      await scan();
    });
  }
});

test.describe('the waiting chip on Update branch', () => {
  test('Updating branch counts down to the refresh, with no layout shift and no old line', async ({
    page,
    request,
    baseURL,
  }) => {
    await registerAndSignIn(page, request, baseURL);
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
    await page.route('**/api/dashboard*', answer);
    await page.route('**/api/dashboard/refresh', answer);
    await page.route('**/api/pull-requests/update-branch', (route: Route) => {
      accepted = true;
      return route.fulfill({ status: 202 });
    });
    await page.reload();

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
    test(`${s.name} in progress is a ${s.label} chip, and the row does not move`, async ({
      page,
      request,
      baseURL,
    }) => {
      await registerAndSignIn(page, request, baseURL);
      const answer = (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot(makePR())),
        });
      await page.route('**/api/dashboard*', answer);
      await page.route('**/api/dashboard/refresh', answer);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(`**/api/pull-requests/${s.endpoint}`, async (route) => {
        await gate;
        return route.fulfill({ status: 204 });
      });
      await page.reload();

      const row = firstRow(page);
      // Close sits in More actions, with the Hide items (#841).
      if (s.endpoint === 'close')
        await row.getByRole('button', { name: 'More actions' }).click();
      await row.getByRole('button', { name: s.button, exact: true }).click();
      const confirm = row.getByRole('button', { name: s.confirm });
      await expect(confirm).toBeVisible();
      const before = await layout(page);
      await confirm.click();

      await expect(chipOf(page).locator('.wait-chip-label')).toHaveText(
        s.label,
      );
      await expect(chipOf(page).getByRole('button')).toHaveCount(0);
      const after = await layout(page);
      // The chip's own slot is fixed, and the row is as wide as before and
      // no taller: it may be shorter, since the confirm group (a longer
      // "Confirm close pull request?" wraps) goes away in the same moment.
      expect(after.slot).toEqual(before.slot);
      expect(after.row.width).toBe(before.row.width);
      expect(after.row.height).toBeLessThanOrEqual(before.row.height);
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
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(pr)),
      }),
    );
    await page.reload();
  }

  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('an armed pull request reads Waiting for CI, with Disarm in the chip and the reason in the tooltip', async ({
    page,
  }) => {
    await open(page, armed());
    const chip = chipOf(page);
    await expect(chip.locator('.wait-chip-label')).toHaveText('Waiting for CI');
    await expect(chip.locator('.wait-chip-detail')).toHaveText(
      'Merges when CI passes',
    );
    await expect(chip.locator('.wait-chip-tip')).toHaveText(
      'Auto-merge is waiting for checks to finish.',
    );
    await expect(
      chip.getByRole('button', { name: 'Disarm auto-merge' }),
    ).toBeVisible();
    await expect(firstRow(page).locator('.auto-merge-status')).toHaveCount(0);
    await expect(firstRow(page)).not.toContainText('Waiting:');
  });

  test('the action area is the same size armed and not', async ({ page }) => {
    await open(page, makePR({ forge: 'forgejo', repo: 'alrayyes/dotfiles' }));
    await expect(slotOf(page)).toBeVisible();
    const plain = await size(slotOf(page));
    await page.unroute('**/api/dashboard*');
    await open(page, armed());
    await expect(chipOf(page)).toBeVisible();
    expect(await size(slotOf(page))).toEqual(plain);
  });

  test('Disarm posts for that pull request', async ({ page }) => {
    let posted: unknown = null;
    await page.route(
      '**/api/pull-requests/auto-merge/cancel',
      (route: Route) => {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      },
    );
    await page.route('**/api/dashboard/refresh', (route: Route) =>
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
      .getByRole('button', { name: 'Disarm auto-merge' })
      .click();
    await expect
      .poll(() => posted)
      .toEqual({
        forge: 'forgejo',
        fullName: 'alrayyes/dotfiles',
        number: 7,
      });
  });

  test('a stopped auto-merge is not a wait: it stays a text line with no chip', async ({
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
    await expect(chipOf(page)).toHaveCount(0);
    await expect(firstRow(page).locator('.auto-merge-status')).toContainText(
      'Stopped',
    );
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe violations with the chip (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, armed());
      await expect(chipOf(page)).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
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

  test('is one Queued chip with the reset time, Cancel inside, and the same slot size', async ({
    page,
    request,
    baseURL,
  }) => {
    await registerAndSignIn(page, request, baseURL);
    const pr = makePR({ behind: true, mergeStatus: 'blocked' });
    let queued: ReturnType<typeof queuedItem> | null = null;
    await page.route('**/api/dashboard*', (route: Route) =>
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
    await page.route('**/api/queued-actions/*', (route: Route) => {
      deletes.push(route.request().url().split('/').pop() ?? '');
      return route.fulfill({ status: 204 });
    });
    await page.reload();
    await expect(slotOf(page)).toBeVisible();
    const plain = await size(slotOf(page));

    queued = queuedItem(new Date(Date.now() + 8 * 60_000).toISOString());
    await page.reload();

    const chip = chipOf(page);
    await expect(chip.locator('.wait-chip-label')).toHaveText(
      /^Queued · \d{1,2}:\d{2}$/,
    );
    const resets = chip.locator('.wait-chip-detail');
    await expect(resets).toContainText(/Resets in [78]m/);
    await expect(resets.locator('[aria-hidden="true"]')).toHaveCount(1);
    expect(await size(slotOf(page))).toEqual(plain);

    await chip
      .getByRole('button', {
        name: 'Cancel queued update for alrayyes/forge-dashboard#42',
      })
      .click();
    await expect.poll(() => deletes).toEqual(['q1']);
  });
});

// #1293: GitHub's own auto-merge reads like Forgejo's, with the same chip and
// a Disarm that goes to GitHub through the same endpoint.
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
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(pr)),
      }),
    );
    await page.reload();
  }

  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('an armed GitHub pull request reads Waiting for CI, with Disarm in the chip', async ({
    page,
  }) => {
    await open(page, armed());
    const chip = chipOf(page);
    await expect(chip.locator('.wait-chip-label')).toHaveText('Waiting for CI');
    await expect(chip.locator('.wait-chip-tip')).toHaveText(
      'Auto-merge is on. GitHub merges it when the checks pass.',
    );
    await expect(
      chip.getByRole('button', { name: 'Disarm auto-merge' }),
    ).toBeVisible();
    await expect(firstRow(page).locator('.auto-merge-status')).toHaveCount(0);
  });

  test('Disarm posts for that GitHub pull request', async ({ page }) => {
    let posted: unknown = null;
    await page.route(
      '**/api/pull-requests/auto-merge/cancel',
      (route: Route) => {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      },
    );
    await page.route('**/api/dashboard/refresh', (route: Route) =>
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
      .getByRole('button', { name: 'Disarm auto-merge' })
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

  test('a stopped GitHub auto-merge stays a text line with no chip', async ({
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
    await expect(chipOf(page)).toHaveCount(0);
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
