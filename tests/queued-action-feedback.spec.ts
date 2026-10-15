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
import { settle } from './settle-helper';

// #680, #714: Update branch, Dependabot rebase and Renovate rebase all
// answer with "Queued…" the instant they're clicked and hold that state
// until the next refresh (or a failure). The row says so with its waiting
// chip (#1229), and Update branch's counts down to the next poll; a toast
// and the Activity panel carry the same events. The top banner is not used.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `queued-action-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'Queued Action Test User',
  );
}

// Resolves once every request the page issued before this call has reached
// the route handlers: intercepted requests are delivered in the order they
// were sent, so a sentinel fetch that comes back means an earlier stray
// request would already be counted. Lets a negative check wait on something
// real instead of sleeping (#1378).
async function requestsDelivered(page: Page) {
  await page.route('**/__sentinel', (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.evaluate(() => fetch('/__sentinel'));
}

interface MockPR {
  forge: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  ci: string;
  labels: { name: string; color: string }[];
  createdAt: string;
  updatedAt: string;
  mergeStatus: string;
  behind: boolean;
  updateRequest?: {
    phase: string;
    requestedAt: string;
    expiresAt: string;
  };
  botRequest?: {
    bot: string;
    action: string;
    phase: string;
    requestedAt: string;
    expiresAt: string;
  };
}

// What the server puts on a pull request once a bot was asked (#808).
function botRequestFor(bot: string, phase: string) {
  return {
    bot,
    action: 'rebase',
    phase,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

// What the server puts on a pull request once an Update branch was
// accepted and the branch is still behind (#982).
function withUpdateRequest(pr: MockPR): MockPR {
  return {
    ...pr,
    updateRequest: {
      phase: 'queued',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  };
}

function makePR(overrides: Partial<MockPR> = {}): MockPR {
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
    mergeStatus: 'blocked',
    behind: false,
    ...overrides,
  };
}

function snapshot(pr: MockPR) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: pr.forge, reachable: true, repoCount: 1 }],
    pullRequests: [pr],
    issues: [],
  };
}

function mockDashboard(page: Page, pr: MockPR) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(pr)),
    }),
  );
}

async function openMoreActions(row: Locator) {
  await row.getByRole('button', { name: 'More actions' }).click();
}

const COUNTDOWN = /next refresh in (\d+)s/i;

// A failure still reads as a line under the row; a wait is the chip.
const inline = (page: Page) =>
  page.locator('#pr-rows .row').first().locator('.row-feedback');
const chip = (page: Page) =>
  page.locator('#pr-rows .row').first().locator('.wait-chip');

async function countdownSeconds(page: Page): Promise<number> {
  const text =
    (await chip(page).locator('.feedback-countdown').textContent()) ?? '';
  const seconds = COUNTDOWN.exec(text)?.[1];
  expect(seconds, `no countdown on the row: ${text}`).toBeDefined();
  return Number(seconds);
}

interface Scenario {
  name: string;
  pr: MockPR;
  endpoint: string;
  openMenu: boolean;
  button: string;
  // What the disabled button reads once clicked: a bot rebase says what
  // was requested (#707), Update branch is a plain queue.
  queuedLabel: string;
  // The chip's label.
  waiting: string;
  // Only Update branch waits on the dashboard's own next refresh; a bot
  // rebase waits on the bot (#707).
  awaitsRefresh: boolean;
  // The toast sentence, without the reference the toast shows itself.
  toast: string;
  // What the live region says, once.
  announced: string;
  failure: string;
  // Update branch runs every test below. The bot scenarios run only the
  // button label, the endpoint and the failure: the rest is the same code
  // path with different strings (#1380).
  full: boolean;
}

const scenarios: Scenario[] = [
  {
    name: 'Update branch',
    pr: makePR({ behind: true }),
    endpoint: '**/api/pull-requests/update-branch',
    openMenu: false,
    button: 'Update branch',
    queuedLabel: 'Queued…',
    awaitsRefresh: true,
    waiting: 'Updating branch',
    toast: 'Branch update requested.',
    announced: 'Branch update requested.',
    failure: "Couldn't update the branch: upstream broke",
    full: true,
  },
  {
    name: 'Dependabot rebase',
    pr: makePR({ author: 'dependabot' }),
    endpoint: '**/api/pull-requests/dependabot-action',
    openMenu: true,
    button: 'Dependabot: Rebase',
    queuedLabel: 'Rebase requested',
    awaitsRefresh: false,
    waiting: 'Rebase requested',
    toast: 'Dependabot rebase requested.',
    announced: 'Dependabot rebase requested.',
    failure: "Couldn't ask Dependabot to rebase: upstream broke",
    full: false,
  },
  {
    name: 'Renovate rebase',
    pr: makePR({ author: 'renovate[bot]' }),
    endpoint: '**/api/pull-requests/renovate-rebase',
    openMenu: true,
    button: 'Renovate: Rebase',
    queuedLabel: 'Rebase requested',
    awaitsRefresh: false,
    waiting: 'Rebase requested',
    toast: 'Renovate rebase requested.',
    announced: 'Renovate rebase requested.',
    failure: "Couldn't ask Renovate to rebase: upstream broke",
    full: false,
  },
];

for (const s of scenarios) {
  test.describe(`queued state: ${s.name}`, () => {
    test.beforeEach(async ({ page, request, baseURL }) => {
      await registerAndSignIn(page, request, baseURL);
      // Bot pull requests are on the Bots page, not the main list (#1192).
      if (/^(dependabot|renovate)/.test(s.pr.author))
        await page.goto('/bots.html');
      await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ allowBotPrUpdates: false }),
        }),
      );
    });

    async function prepare(
      page: Page,
      endpointStatus = 204,
      fakeClock = false,
    ) {
      await mockDashboard(page, s.pr);
      let hits = 0;
      // How many of those responses the mock has sent, and how many force
      // refreshes it has answered: what a test waits on instead of a sleep.
      let responded = 0;
      let refreshed = 0;
      // Every snapshot after an accepted Update branch carries the server's
      // record of it, until the branch is no longer behind (#982).
      let accepted = false;
      const served = () =>
        accepted && s.awaitsRefresh ? withUpdateRequest(s.pr) : s.pr;
      await page.route('**/api/dashboard*', (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot(served())),
        }),
      );
      await page.route(s.endpoint, async (route: Route) => {
        hits += 1;
        if (endpointStatus === 204 || endpointStatus === 202) accepted = true;
        // Slow enough that the assertions below run while still in flight.
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (endpointStatus === 204 || endpointStatus === 202) {
          await route.fulfill({ status: endpointStatus });
        } else {
          await route.fulfill({
            status: endpointStatus,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'github: PUT /x: upstream broke',
              message: 'upstream broke',
            }),
          });
        }
        responded += 1;
      });
      // The Update branch handler force-refreshes; keep the PR behind so
      // the queued state has to hold across that refresh.
      await page.route('**/api/dashboard/refresh', async (route: Route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot(served())),
        });
        refreshed += 1;
      });
      // Installed before the reload so the page's timers run on the fake clock
      // and a test moves time with runFor instead of sleeping (#1378). The
      // mock's own 300 ms delay is Node-side real time and isn't affected.
      if (fakeClock) await page.clock.install();
      await page.reload();
      const row = page.locator('#pr-rows .row').first();
      if (s.openMenu) await openMoreActions(row);
      return {
        row,
        hits: () => hits,
        responded: () => responded,
        refreshed: () => refreshed,
      };
    }

    // Waits until the mock has answered the request (and, for Update branch, the
    // force refresh that follows it), then for the page to draw what that
    // caused: two animation frames. Replaces a fixed sleep (#1378). Not for a
    // test that installs the fake clock, which fakes animation frames too.
    async function afterResponseLands(
      page: Page,
      mocks: { responded: () => number; refreshed: () => number },
    ) {
      await expect.poll(mocks.responded).toBe(1);
      if (s.awaitsRefresh)
        await expect.poll(mocks.refreshed).toBeGreaterThan(0);
      await settle(page);
    }

    test('the button reads Queued… and is disabled right after the click, only one request is sent, and a menu closes with focus on its trigger', async ({
      page,
    }) => {
      const mocks = await prepare(page);
      const { row, hits } = mocks;
      const button = row.getByRole('button', { name: s.button });
      await button.click();

      const queued = row.getByRole('button', { name: s.queuedLabel });
      await expect(queued).toBeVisible();
      await expect(queued).toBeDisabled();
      // A negative check: no second request follows. Wait until the answer
      // and the render it causes are in, then count.
      await afterResponseLands(page, mocks);
      expect(hits()).toBe(1);

      // #690: a bot action sits in the More actions menu. Once the request
      // is answered the board re-renders, the menu closes and focus lands on
      // its trigger in the same row. Only the bot scenarios have a menu, and
      // the full-only test below can't prove it for them.
      if (s.openMenu) {
        await afterResponseLands(page, mocks);
        await expect(
          page
            .locator('#pr-rows .row')
            .first()
            .getByRole('button', { name: 'More actions' }),
        ).toBeFocused();
      }
    });

    if (s.full) {
      // #690: a native `disabled` button drops focus, so a keyboard or
      // screen reader user loses their place. The queued button is
      // aria-disabled instead: still focusable, ignores clicks.
      test('the queued button is aria-disabled, keeps focus across the re-render, ignores clicks and passes axe', async ({
        page,
      }) => {
        const mocks = await prepare(page);
        const { row, hits } = mocks;
        const button = row.getByRole('button', { name: s.button });
        await button.focus();
        await button.press('Enter');

        const queuedButton = () =>
          page
            .locator('#pr-rows .row')
            .first()
            .getByRole('button', { name: s.queuedLabel });
        await expect(queuedButton()).toHaveAttribute('aria-disabled', 'true');
        await expect(queuedButton()).not.toHaveAttribute('disabled', /.*/);
        await expect(queuedButton()).toBeFocused();

        // The mock holds the response 300ms; the handler re-renders after.
        await expect.poll(hits).toBe(1);
        await afterResponseLands(page, mocks);
        await expect(queuedButton()).toBeFocused();
        await expect(queuedButton()).toHaveAttribute('aria-disabled', 'true');

        // Playwright refuses to click an aria-disabled button unless forced.
        await queuedButton().click({ force: true });
        // A negative check: no second request follows the forced click. The
        // sentinel returns only after any such request reached the mock.
        await requestsDelivered(page);
        await settle(page);
        expect(hits()).toBe(1);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }

    // Update branch waits on the dashboard's own refresh, so its chip counts
    // down to it. A bot rebase waits on the bot, so its chip counts the age.
    test('the row says the action is waiting, with no banner', async ({
      page,
    }) => {
      const { row } = await prepare(page);
      await row.getByRole('button', { name: s.button }).click();

      await expect(chip(page).locator('.wait-chip-label')).toHaveText(
        s.waiting,
      );
      if (s.awaitsRefresh) await expect(chip(page)).toContainText(COUNTDOWN);
      else
        await expect(chip(page).locator('.feedback-countdown')).toHaveCount(0);
      await expect(page.locator('#status-banner')).toHaveCount(0);
      await expect(page.locator('#error-banner')).toHaveCount(0);
      await expect(inline(page)).toHaveCount(0);
    });

    if (s.full) {
      test('the countdown runs down to the real next poll', async ({
        page,
      }) => {
        const { row } = await prepare(page, 204, true);
        await row.getByRole('button', { name: s.button }).click();
        await expect(chip(page)).toContainText(COUNTDOWN);

        // Derived from the 30s poll cadence, never a hard-coded number.
        const first = await countdownSeconds(page);
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThanOrEqual(30);
        // Far enough from the poll that none fires while the clock runs below.
        expect(first).toBeGreaterThan(5);
        await page.clock.runFor(2500);
        // The clock moved 2.5 s. The text only changes on the one-second tick, so
        // it fell by one to four seconds depending on where the tick fell: down,
        // and not by more than the clock moved.
        const fell = first - (await countdownSeconds(page));
        expect(fell).toBeGreaterThanOrEqual(1);
        expect(fell).toBeLessThanOrEqual(4);
      });

      test('a toast confirms the request and Activity lists it as queued', async ({
        page,
      }) => {
        const { row } = await prepare(page);
        await row.getByRole('button', { name: s.button }).click();

        const toast = page.locator('#feedback-toasts .feedback-toast').first();
        await expect(toast).toContainText('alrayyes/forge-dashboard#42');
        await expect(toast).toContainText(s.toast);
        await page.locator('#activity-toggle').click();
        const item = page.locator('#activity-panel .activity-item').first();
        await expect(item).toContainText('Queued');
        await expect(item).toContainText(s.toast);
      });

      test('the countdown is outside the live region, so it does not chatter', async ({
        page,
      }) => {
        const { row } = await prepare(page, 204, true);
        await row.getByRole('button', { name: s.button }).click();

        const ticking = chip(page).locator('.feedback-countdown');
        await expect(ticking).toHaveAttribute('aria-hidden', 'true');
        // The announced text is stable: said once, no digits that change
        // each second.
        const live = page.locator('#feedback-live');
        await expect(live).toHaveText(
          `alrayyes/forge-dashboard#42: ${s.announced}`,
        );
        await page.clock.runFor(2200);
        await expect(live).toHaveText(
          `alrayyes/forge-dashboard#42: ${s.announced}`,
        );
        await expect(live).not.toContainText(/\d+s/);
        await expect(live.locator('.feedback-countdown')).toHaveCount(0);
        await expect(live.locator('.feedback-requested')).toHaveCount(0);
      });

      test('the queued state survives the re-render that follows the request completing', async ({
        page,
      }) => {
        const mocks = await prepare(page);
        const { row, hits } = mocks;
        await row.getByRole('button', { name: s.button }).click();
        // The mock holds the response for 300ms; the handler re-renders the
        // board (and Update branch force-refreshes) once it lands.
        await expect.poll(hits).toBe(1);
        await afterResponseLands(page, mocks);

        const fresh = page.locator('#pr-rows .row').first();
        await expect(
          fresh.getByRole('button', { name: s.queuedLabel }),
        ).toBeDisabled();
        await expect(chip(page).locator('.wait-chip-label')).toHaveText(
          s.waiting,
        );
      });

      // #706: the banner used to vanish about a second after the click,
      // because any snapshot (the live stream pushes one constantly)
      // cleared a queued bot rebase. It has to hold until a snapshot that
      // actually reflects the action lands.
      test('the chip survives well past a second and an unrelated stream push', async ({
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
        const { row } = await prepare(page, 204, true);
        await row.getByRole('button', { name: s.button }).click();
        const line = chip(page).locator('.wait-chip-label');
        await expect(line).toHaveText(s.waiting);

        await page.clock.runFor(3200);
        await expect(line).toHaveText(s.waiting);

        // A snapshot that doesn't change this pull request's state. A bot
        // request is still on the pull request, as the server keeps it.
        const same = withUpdateRequest(s.pr);
        await page.evaluate(
          (data) => {
            const w = window as unknown as { __streams: EventSource[] };
            for (const stream of w.__streams)
              stream.onmessage?.(new MessageEvent('message', { data }));
          },
          JSON.stringify(snapshot(same)),
        );
        await page.clock.runFor(1500);
        await expect(line).toHaveText(s.waiting);
        await expect(
          page.locator('#feedback-toasts .feedback-toast'),
        ).toHaveCount(1);
        const fresh = page.locator('#pr-rows .row').first();
        await expect(
          fresh.getByRole('button', { name: s.queuedLabel }),
        ).toBeDisabled();
      });

      test('the row says Refreshing… rather than vanishing when the countdown hits zero', async ({
        page,
      }) => {
        await page.addInitScript(() => {
          const w = window as unknown as { __skew: number };
          w.__skew = 0;
          const real = Date.now.bind(Date);
          Date.now = () => real() + w.__skew;
        });
        const { row } = await prepare(page);
        await row.getByRole('button', { name: s.button }).click();
        const line = chip(page);
        await expect(line).toContainText(COUNTDOWN);

        await page.evaluate(() => {
          (window as unknown as { __skew: number }).__skew = 60_000;
        });
        await expect(line).toContainText('Refreshing…');
        await expect(line).toContainText(s.waiting);
        await expect(line).not.toContainText(COUNTDOWN);
      });
    }

    test('a failure re-enables the button, fails the row line and raises an error toast', async ({
      page,
    }) => {
      const { row } = await prepare(page, 502);
      await row.getByRole('button', { name: s.button }).click();
      await expect(
        row.getByRole('button', { name: s.queuedLabel }),
      ).toBeVisible();

      const toast = page.locator('#feedback-toasts .feedback-toast').first();
      await expect(toast).toContainText(s.failure);
      await expect(toast).toContainText('alrayyes/forge-dashboard#42');
      const line = inline(page);
      await expect(line).toContainText('Failed');
      await expect(line).toContainText('upstream broke');
      await expect(chip(page)).toHaveCount(0);
      await expect(page.locator('#error-banner')).toHaveCount(0);
      await expect(page.locator('#status-banner')).toHaveCount(0);
      await expect(
        row.getByRole('button', { name: s.queuedLabel }),
      ).toHaveCount(0);
      await expect(row.getByRole('button', { name: s.button })).toBeEnabled();
    });

    if (s.full) {
      test('has no axe violations while queued', async ({ page }) => {
        const { row } = await prepare(page);
        await row.getByRole('button', { name: s.button }).click();
        await expect(chip(page).locator('.wait-chip-label')).toHaveText(
          s.waiting,
        );
        await page.locator('#activity-toggle').click();

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  });
}

test.describe('queued state: bot rebases move on once a snapshot shows pickup', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    // Bot pull requests are on the Bots page, not the main list (#1192).
    await page.goto('/bots.html');
    await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowBotPrUpdates: false }),
      }),
    );
  });

  test('a Renovate rebase stays queued after the request succeeds, then moves to Rebasing once a snapshot shows it landed', async ({
    page,
  }) => {
    const pr = makePR({ author: 'renovate[bot]', behind: true });
    await mockDashboard(page, pr);
    let rebased = 0;
    let refreshes = 0;
    await page.route(
      '**/api/pull-requests/renovate-rebase',
      async (route: Route) => {
        await route.fulfill({ status: 204 });
        rebased += 1;
      },
    );
    await page.route('**/api/dashboard/refresh', (route: Route) => {
      refreshes += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        // The refresh that follows shows the server saw the rebase land.
        body: JSON.stringify(
          snapshot({
            ...pr,
            behind: false,
            botRequest: botRequestFor('renovate', 'rebasing'),
          }),
        ),
      });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Renovate: Rebase' }).click();

    // The request is done, but nothing has refreshed yet. A negative check:
    // wait for the answer, for any stray refresh to reach the mock, and for
    // the render, then look.
    await expect.poll(() => rebased).toBe(1);
    await requestsDelivered(page);
    await settle(page);
    expect(refreshes).toBe(0);
    await expect(row.locator('.wait-chip-label')).toHaveText(
      'Rebase requested',
    );
    await openMoreActions(row).catch(() => undefined);
    await expect(
      row.getByRole('button', { name: 'Rebase requested' }),
    ).toBeDisabled();

    await page.click('#force-refresh-button');

    // Picked up (#707): the chip says Rebasing until CI restarts rather
    // than going quiet. The chip is covered by bot-rebase-pickup.spec.ts;
    // what matters here is that the request is no longer "waiting for the
    // bot".
    await expect(row.locator('.wait-chip-label')).toHaveText('Rebasing');
  });

  // #711, #808: a bot that never acts must not pin the button disabled for
  // good. The server decides when to give up; the page shows it.
  test('a bot rebase the server expired shows an error toast and frees the button', async ({
    page,
  }) => {
    const pr = makePR({ author: 'renovate[bot]', behind: true });
    await mockDashboard(page, pr);
    await page.route('**/api/pull-requests/renovate-rebase', (route: Route) =>
      route.fulfill({ status: 204 }),
    );
    await page.route('**/api/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        // Still behind: the bot did nothing, and the server gave up.
        body: JSON.stringify(
          snapshot({ ...pr, botRequest: botRequestFor('renovate', 'expired') }),
        ),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Renovate: Rebase' }).click();
    await expect(row.locator('.wait-chip-label')).toHaveText(
      'Rebase requested',
    );

    await page.click('#force-refresh-button');

    const line = page.locator('#pr-rows .row').first().locator('.row-feedback');
    await expect(line).toContainText('Timed out');
    await expect(line.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(
      page.locator('#feedback-toasts .feedback-toast[data-kind="error"]'),
    ).toContainText("Renovate hasn't acted");
    const fresh = page.locator('#pr-rows .row').first();
    await openMoreActions(fresh);
    await expect(
      fresh.getByRole('button', { name: 'Renovate: Rebase' }),
    ).toBeEnabled();
  });
});
