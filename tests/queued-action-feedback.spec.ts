import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

// #680, #714: Update branch, Dependabot rebase and Renovate rebase all
// answer with "Queued…" the instant they're clicked and hold that state
// until the next refresh (or a failure). The row says so in its own inline
// status line, with a countdown to the next poll; a toast and the
// Activity panel carry the same events. The top banner is not used.

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

const COUNTDOWN = /next refresh in (\d+)s/;

const inline = (page: Page) =>
  page.locator('#pr-rows .row').first().locator('.row-feedback');

async function countdownSeconds(page: Page): Promise<number> {
  const text =
    (await inline(page).locator('.feedback-countdown').textContent()) ?? '';
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
  // The row's inline status.
  waiting: string;
  // Only Update branch waits on the dashboard's own next refresh; a bot
  // rebase waits on the bot (#707).
  awaitsRefresh: boolean;
  // The toast sentence, without the reference the toast shows itself.
  toast: string;
  // What the live region says, once.
  announced: string;
  failure: string;
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
    waiting: 'Queued',
    toast: 'Branch update requested.',
    announced: 'Branch update requested. Awaiting the next refresh.',
    failure: "Couldn't update the branch: upstream broke",
  },
  {
    name: 'Dependabot rebase',
    pr: makePR({ author: 'dependabot' }),
    endpoint: '**/api/pull-requests/dependabot-action',
    openMenu: true,
    button: 'Dependabot: Rebase',
    queuedLabel: 'Rebase requested',
    awaitsRefresh: false,
    waiting: 'Dependabot will pick this up shortly',
    toast: 'Dependabot rebase requested.',
    announced: 'Dependabot rebase requested. It will pick this up shortly.',
    failure: "Couldn't ask Dependabot to rebase: upstream broke",
  },
  {
    name: 'Renovate rebase',
    pr: makePR({ author: 'renovate[bot]' }),
    endpoint: '**/api/pull-requests/renovate-rebase',
    openMenu: true,
    button: 'Renovate: Rebase',
    queuedLabel: 'Rebase requested',
    awaitsRefresh: false,
    waiting: 'Renovate will pick this up shortly',
    toast: 'Renovate rebase requested.',
    announced: 'Renovate rebase requested. It will pick this up shortly.',
    failure: "Couldn't ask Renovate to rebase: upstream broke",
  },
];

for (const s of scenarios) {
  test.describe(`queued state: ${s.name}`, () => {
    test.beforeEach(async ({ page, request, baseURL }) => {
      await registerAndSignIn(page, request, baseURL);
      await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ allowBotPrUpdates: false }),
        }),
      );
    });

    async function prepare(page: Page, endpointStatus = 204) {
      await mockDashboard(page, s.pr);
      let hits = 0;
      await page.route(s.endpoint, async (route: Route) => {
        hits += 1;
        // Slow enough that the assertions below run while still in flight.
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (endpointStatus === 204 || endpointStatus === 202)
          return route.fulfill({ status: endpointStatus });
        return route.fulfill({
          status: endpointStatus,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'github: PUT /x: upstream broke',
            message: 'upstream broke',
          }),
        });
      });
      // The Update branch handler force-refreshes; keep the PR behind so
      // the queued state has to hold across that refresh.
      await page.route('**/api/dashboard/refresh', (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot(s.pr)),
        }),
      );
      await page.reload();
      const row = page.locator('#pr-rows .row').first();
      if (s.openMenu) await openMoreActions(row);
      return { row, hits: () => hits };
    }

    test('the button reads Queued… and is disabled right after the click, and only one request is sent', async ({
      page,
    }) => {
      const { row, hits } = await prepare(page);
      const button = row.getByRole('button', { name: s.button });
      await button.click();

      const queued = row.getByRole('button', { name: s.queuedLabel });
      await expect(queued).toBeVisible();
      await expect(queued).toBeDisabled();
      await page.waitForTimeout(500);
      expect(hits()).toBe(1);
    });

    // #690: a native `disabled` button drops focus, so a keyboard or
    // screen reader user loses their place. The queued button is
    // aria-disabled instead: still focusable, ignores clicks.
    test('the queued button is aria-disabled, keeps focus across the re-render, ignores clicks and passes axe', async ({
      page,
    }) => {
      const { row, hits } = await prepare(page);
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
      await page.waitForTimeout(800);
      if (s.openMenu) {
        // The menu closes on the re-render (an open one would hold the
        // board back), so focus lands on its trigger, in the same row.
        await expect(
          page
            .locator('#pr-rows .row')
            .first()
            .getByRole('button', { name: 'More actions' }),
        ).toBeFocused();
        await openMoreActions(page.locator('#pr-rows .row').first());
      } else {
        await expect(queuedButton()).toBeFocused();
      }
      await expect(queuedButton()).toHaveAttribute('aria-disabled', 'true');

      // Playwright refuses to click an aria-disabled button unless forced.
      await queuedButton().click({ force: true });
      await page.waitForTimeout(500);
      expect(hits()).toBe(1);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });

    test('the row says the action is waiting and counts down to the real next poll, with no banner', async ({
      page,
    }) => {
      const { row } = await prepare(page);
      await row.getByRole('button', { name: s.button }).click();

      const line = inline(page);
      await expect(line).toContainText(s.waiting);
      if (s.awaitsRefresh)
        await expect(line).toContainText('Awaiting the next refresh');
      await expect(line).toContainText(COUNTDOWN);
      await expect(page.locator('#status-banner')).toHaveCount(0);
      await expect(page.locator('#error-banner')).toHaveCount(0);

      // Derived from the 30s poll cadence, never a hard-coded number.
      const first = await countdownSeconds(page);
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThanOrEqual(30);
      await page.waitForTimeout(2500);
      expect(await countdownSeconds(page)).toBeLessThan(first);
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
      const { row } = await prepare(page);
      await row.getByRole('button', { name: s.button }).click();

      const countdown = inline(page).locator('.feedback-countdown');
      await expect(countdown).toHaveAttribute('aria-hidden', 'true');
      // The announced text is stable: said once, no digits that change
      // each second.
      const live = page.locator('#feedback-live');
      await expect(live).toHaveText(
        `alrayyes/forge-dashboard#42: ${s.announced}`,
      );
      await page.waitForTimeout(2200);
      await expect(live).toHaveText(
        `alrayyes/forge-dashboard#42: ${s.announced}`,
      );
      await expect(live).not.toContainText(/\d+s/);
      await expect(live.locator('.feedback-countdown')).toHaveCount(0);
    });

    test('the queued state survives the re-render that follows the request completing', async ({
      page,
    }) => {
      const { row, hits } = await prepare(page);
      await row.getByRole('button', { name: s.button }).click();
      // The mock holds the response for 300ms; the handler re-renders the
      // board (and Update branch force-refreshes) once it lands.
      await expect.poll(hits).toBe(1);
      await page.waitForTimeout(800);

      const fresh = page.locator('#pr-rows .row').first();
      if (s.openMenu) await openMoreActions(fresh);
      await expect(
        fresh.getByRole('button', { name: s.queuedLabel }),
      ).toBeDisabled();
      await expect(inline(page)).toContainText(COUNTDOWN);
    });

    // #706: the banner used to vanish about a second after the click,
    // because any snapshot (the live stream pushes one constantly)
    // cleared a queued bot rebase. It has to hold until a snapshot that
    // actually reflects the action lands.
    test('the inline line survives well past a second and an unrelated stream push', async ({
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
      const { row } = await prepare(page);
      await row.getByRole('button', { name: s.button }).click();
      const line = inline(page);
      await expect(line).toContainText(COUNTDOWN);

      await page.waitForTimeout(3200);
      await expect(line).toContainText(s.waiting);
      await expect(line).toContainText(COUNTDOWN);

      // A snapshot that doesn't change this pull request's state.
      await page.evaluate(
        (data) => {
          const w = window as unknown as { __streams: EventSource[] };
          for (const stream of w.__streams)
            stream.onmessage?.(new MessageEvent('message', { data }));
        },
        JSON.stringify(snapshot(s.pr)),
      );
      await page.waitForTimeout(1500);
      await expect(line).toContainText(s.waiting);
      await expect(line).toContainText(COUNTDOWN);
      await expect(
        page.locator('#feedback-toasts .feedback-toast'),
      ).toHaveCount(1);
      const fresh = page.locator('#pr-rows .row').first();
      if (s.openMenu) await openMoreActions(fresh);
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
      const line = inline(page);
      await expect(line).toContainText(COUNTDOWN);

      await page.evaluate(() => {
        (window as unknown as { __skew: number }).__skew = 60_000;
      });
      await expect(line).toContainText('Refreshing…');
      await expect(line).toContainText(s.waiting);
      await expect(line).not.toContainText(COUNTDOWN);
    });

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
      await expect(line).not.toContainText(COUNTDOWN);
      await expect(page.locator('#error-banner')).toHaveCount(0);
      await expect(page.locator('#status-banner')).toHaveCount(0);
      await expect(
        row.getByRole('button', { name: s.queuedLabel }),
      ).toHaveCount(0);
      await expect(row.getByRole('button', { name: s.button })).toBeEnabled();
    });

    test('has no axe violations while queued', async ({ page }) => {
      const { row } = await prepare(page);
      await row.getByRole('button', { name: s.button }).click();
      await expect(inline(page)).toContainText(COUNTDOWN);
      await page.locator('#activity-toggle').click();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });
}

test.describe('queued state: bot rebases move on once a snapshot shows pickup', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowBotPrUpdates: false }),
      }),
    );
  });

  test('a Renovate rebase stays queued after the request succeeds, then moves to Rebasing… once a snapshot shows it landed', async ({
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
        // The refresh that follows shows the rebase landed.
        body: JSON.stringify(snapshot({ ...pr, behind: false })),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Renovate: Rebase' }).click();

    // The request is done, but nothing has refreshed yet.
    await page.waitForTimeout(500);
    await expect(row.locator('.row-feedback')).toContainText(COUNTDOWN);
    await openMoreActions(row).catch(() => undefined);
    await expect(
      row.getByRole('button', { name: 'Rebase requested' }),
    ).toBeDisabled();

    await page.click('#force-refresh-button');

    // Picked up (#707): the row says Rebasing… until CI restarts rather
    // than going quiet. The pill and the line are covered by
    // bot-rebase-pickup.spec.ts; what matters here is that the request
    // is no longer "waiting for the bot".
    await expect(row.locator('.row-feedback')).not.toContainText(COUNTDOWN);
    await expect(row.locator('.merge-pill.rebasing')).toHaveText('Rebasing…');
  });

  // #711: a bot that never acts must not pin the button disabled for good.
  test('a bot rebase nobody picked up expires after five minutes with an error toast', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __skew: number };
      w.__skew = 0;
      const real = Date.now.bind(Date);
      Date.now = () => real() + w.__skew;
    });
    const pr = makePR({ author: 'renovate[bot]', behind: true });
    await mockDashboard(page, pr);
    await page.route('**/api/pull-requests/renovate-rebase', (route: Route) =>
      route.fulfill({ status: 204 }),
    );
    await page.route('**/api/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        // Still behind: the bot did nothing.
        body: JSON.stringify(snapshot(pr)),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Renovate: Rebase' }).click();
    await expect(row.locator('.row-feedback')).toContainText(COUNTDOWN);

    // Four minutes in, still waiting.
    await page.evaluate(() => {
      (window as unknown as { __skew: number }).__skew = 4 * 60_000;
    });
    await page.click('#force-refresh-button');
    // Past two minutes the line says the bot is slow, not broken (#707).
    await expect(row.locator('.row-feedback')).toContainText(
      'Still waiting on Renovate (4m)',
    );

    await page.evaluate(() => {
      (window as unknown as { __skew: number }).__skew = 5 * 60_000 + 5_000;
    });
    await page.waitForTimeout(5200);
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
