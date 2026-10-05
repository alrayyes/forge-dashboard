import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #707: after a Dependabot or Renovate rebase request the row says the
// request went out, that the bot picks it up in its own time, and when it
// has. The wait is on the bot, not on the dashboard's own refresh, so the
// copy says so; the "Requested Ns ago" ticker stays out of the announced
// text the same way the refresh countdown does (#714).
//
// The server owns the request (#808): each pull request in a snapshot
// carries `botRequest`, and the page only draws it. These tests play the
// server by putting that field on the mocked snapshots. The page clears a
// request when a later snapshot no longer has it.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `bot-rebase-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Bot Rebase User');
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
  botRequest?: MockBotRequest;
}

interface MockBotRequest {
  bot: string;
  action: string;
  phase: 'queued' | 'rebasing' | 'expired';
  requestedAt: string;
  expiresAt: string;
}

function botRequest(
  bot: string,
  phase: MockBotRequest['phase'],
  requestedAgoMs = 0,
): MockBotRequest {
  const requestedAt = Date.now() - requestedAgoMs;
  return {
    bot,
    action: 'rebase',
    phase,
    requestedAt: new Date(requestedAt).toISOString(),
    expiresAt: new Date(requestedAt + 5 * 60_000).toISOString(),
  };
}

function makePR(overrides: Partial<MockPR> = {}): MockPR {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Bump a dependency',
    url: 'https://github.com/alrayyes/forge-dashboard/pull/42',
    author: 'dependabot',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
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

const bots = [
  {
    bot: 'Dependabot',
    id: 'dependabot',
    pr: makePR(),
    endpoint: '**/api/pull-requests/dependabot-action',
    button: 'Dependabot: Rebase',
    requested: 'Dependabot will pick this up shortly.',
    detail: 'This can take a few minutes, no need to click again.',
  },
  {
    bot: 'Renovate',
    id: 'renovate',
    pr: makePR({ author: 'renovate[bot]' }),
    endpoint: '**/api/pull-requests/renovate-rebase',
    button: 'Renovate: Rebase',
    requested: 'Renovate will pick this up shortly.',
    detail:
      'The rebase label is set. This can take a few minutes, no need to click again.',
  },
];

const row = (page: Page) => page.locator('#pr-rows .row').first();
const line = (page: Page) => row(page).locator('.row-feedback');

for (const b of bots) {
  test.describe(`bot rebase pickup: ${b.bot}`, () => {
    // What the mocked dashboard currently answers with: a test changes it
    // to play the bot acting.
    let current: MockPR;

    test.beforeEach(async ({ page, request, baseURL }) => {
      current = { ...b.pr };
      await registerAndSignIn(page, request, baseURL);
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
          body: JSON.stringify(snapshot(current)),
        });
      await page.route('**/api/dashboard*', answer);
      await page.route('**/api/dashboard/refresh', answer);
      // The server records the request before it answers 204, so every
      // snapshot after that carries it.
      await page.route(b.endpoint, (route: Route) => {
        current = { ...current, botRequest: botRequest(b.id, 'queued') };
        return route.fulfill({ status: 204 });
      });
      await page.reload();
    });

    async function request(page: Page) {
      await row(page).getByRole('button', { name: b.button }).click();
      await expect(
        row(page).getByRole('button', { name: 'Rebase requested' }),
      ).toBeDisabled();
      // The request itself has been accepted before a test plays the bot.
      await expect(page.locator('#feedback-toasts')).toContainText(
        'rebase requested.',
      );
    }

    async function skew(page: Page, ms: number) {
      await page.evaluate((v) => {
        (window as unknown as { __skew: number }).__skew = v;
      }, ms);
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

    test('a requested rebase shows a disabled button, what happens next and how long ago', async ({
      page,
    }) => {
      await expect(row(page).getByText('Out of date')).toBeVisible();
      await request(page);

      await expect(line(page)).toContainText(b.requested);
      await expect(line(page)).toContainText(b.detail);
      await expect(line(page)).toContainText(/Requested \d+s ago/);
      // No banner: the row line carries the message.
      await expect(page.locator('#status-banner')).toHaveCount(0);
    });

    test('Requested Ns ago keeps ticking and is not read out', async ({
      page,
    }) => {
      await request(page);
      const ago = line(page).locator('.feedback-requested');
      await expect(ago).toHaveAttribute('aria-hidden', 'true');
      await expect(ago).toHaveText('Requested 0s ago');
      await skew(page, 7_000);
      await expect(ago).toHaveText('Requested 7s ago');

      const live = page.locator('#feedback-live');
      await expect(live).not.toContainText(/\d+s ago/);
      await expect(live.locator('.feedback-requested')).toHaveCount(0);
    });

    // #808: the request lives on the server, so a reload mid-wait still
    // shows it, and the "Requested Ns ago" clock counts from when it was
    // asked, not from when the page loaded.
    test('a reload mid-wait still shows the request', async ({ page }) => {
      await request(page);
      await page.reload();

      await expect(
        row(page).getByRole('button', { name: 'Rebase requested' }),
      ).toBeDisabled();
      await expect(line(page)).toContainText(b.requested);
      await expect(line(page)).toContainText(b.detail);
    });

    test('a request seen only in the snapshot counts its age from requestedAt', async ({
      page,
    }) => {
      current = {
        ...current,
        botRequest: botRequest(b.id, 'queued', 90_000),
      };
      await page.reload();
      await expect(line(page)).toContainText(/Requested 1m ago/);
    });

    test('a request that is rebasing in the snapshot shows Rebasing… after a reload', async ({
      page,
    }) => {
      current = {
        ...current,
        behind: false,
        botRequest: botRequest(b.id, 'rebasing'),
      };
      await page.reload();
      await expect(row(page).locator('.merge-pill.rebasing')).toHaveText(
        'Rebasing…',
      );
      await expect(line(page)).toContainText(`${b.bot} picked this up`);
    });

    test('expired in the snapshot shows the timed-out line and a toast, once', async ({
      page,
    }) => {
      await request(page);
      current = {
        ...current,
        botRequest: botRequest(b.id, 'expired', 5 * 60_000),
      };
      await push(page, current);

      await expect(line(page)).toContainText('Timed out');
      await expect(
        line(page).getByRole('button', { name: 'Retry' }),
      ).toBeVisible();
      const toasts = page.locator(
        '#feedback-toasts .feedback-toast[data-kind="error"]',
      );
      await expect(toasts).toContainText(`${b.bot} hasn't acted`);
      await expect(
        row(page).getByRole('button', { name: b.button }),
      ).toBeEnabled();

      // The same expired record on the next snapshot says nothing new.
      await push(page, current);
      await page.waitForTimeout(500);
      await expect(toasts).toHaveCount(1);
    });

    test('the requested line survives a stream push that still shows it queued', async ({
      page,
    }) => {
      await request(page);
      await push(page, current);
      await page.waitForTimeout(500);
      await expect(line(page)).toContainText(b.requested);
      await expect(
        row(page).getByRole('button', { name: 'Rebase requested' }),
      ).toBeDisabled();
      await expect(
        page.locator('#feedback-toasts .feedback-toast'),
      ).toHaveCount(1);
    });

    // #691: a refresh that started before the click can't tell the click
    // happened, so its answer must not end the wait, even when it shows
    // the pull request no longer behind.
    test('a refresh already in flight at the click does not clear the queued state, the next one does', async ({
      page,
    }) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = true;
      // What the refresh that is already in flight answers: it started
      // before the click, so it has no record, and it shows the pull
      // request no longer behind.
      const stale = JSON.stringify(snapshot({ ...current, behind: false }));
      await page.route('**/api/dashboard/refresh', async (route: Route) => {
        if (held) {
          held = false;
          await gate;
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: stale,
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot(current)),
        });
      });

      // The refresh starts first and stays in flight across the click.
      await page.locator('#force-refresh-button').click();
      await row(page).getByRole('button', { name: b.button }).click();
      await expect(
        row(page).getByRole('button', { name: 'Rebase requested' }),
      ).toBeDisabled();

      release();
      await page.waitForTimeout(800);
      await expect(row(page).locator('.merge-pill.rebasing')).toHaveCount(0);
      await expect(line(page)).toContainText(b.requested);

      // A refresh that starts after the click and shows the bot acted.
      current = {
        ...current,
        behind: false,
        botRequest: botRequest(b.id, 'rebasing'),
      };
      await page.locator('#force-refresh-button').click();
      await expect(row(page).locator('.merge-pill.rebasing')).toHaveText(
        'Rebasing…',
      );
    });

    test('once the bot has rebased it the row says Rebasing… until CI restarts', async ({
      page,
    }) => {
      await request(page);
      // The bot force-pushed: no longer behind, CI not restarted yet.
      current = {
        ...current,
        behind: false,
        botRequest: botRequest(b.id, 'rebasing'),
      };
      await push(page, current);

      const pill = row(page).locator('.merge-pill.rebasing');
      await expect(pill).toHaveText('Rebasing…');
      await expect(row(page).getByText('Out of date')).toHaveCount(0);
      await expect(line(page)).toContainText(`${b.bot} picked this up`);
      await expect(line(page)).not.toContainText(/Requested \d+s ago/);
      await expect(page.locator('#feedback-live')).toContainText(
        `${b.bot} picked up the rebase`,
      );

      // CI restarts: the server drops the request, and so does the row.
      current = { ...current, ci: 'pending', botRequest: undefined };
      await push(page, current);
      await expect(row(page).locator('.merge-pill.rebasing')).toHaveCount(0);
      await expect(line(page)).toHaveCount(0);
      await expect(
        page.locator('#feedback-toasts .feedback-toast').first(),
      ).toContainText(`${b.bot} rebase finished.`);
    });

    test('a request the server drops (a repo whose CI never restarts) clears Rebasing…', async ({
      page,
    }) => {
      await request(page);
      current = {
        ...current,
        behind: false,
        botRequest: botRequest(b.id, 'rebasing'),
      };
      await push(page, current);
      await expect(row(page).locator('.merge-pill.rebasing')).toBeVisible();

      current = { ...current, botRequest: undefined };
      await push(page, current);
      await expect(row(page).locator('.merge-pill.rebasing')).toHaveCount(0);
      await expect(line(page)).toHaveCount(0);
    });

    test('a CI run already under way at pickup needs no Rebasing… step', async ({
      page,
    }) => {
      await request(page);
      current = {
        ...current,
        behind: false,
        ci: 'pending',
        botRequest: undefined,
      };
      await push(page, current);
      await expect(row(page).locator('.merge-pill.rebasing')).toHaveCount(0);
      await expect(
        page.locator('#feedback-toasts .feedback-toast').first(),
      ).toContainText(`${b.bot} rebase finished.`);
    });

    test('has no axe violations when requested or rebasing, and none relies on colour alone', async ({
      page,
    }) => {
      const scan = async () => {
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      };
      await request(page);
      await expect(line(page)).toContainText(b.requested);
      await scan();

      current = {
        ...current,
        behind: false,
        botRequest: botRequest(b.id, 'rebasing'),
      };
      await push(page, current);
      // Words, not just a tint: the state is in the text of both.
      await expect(row(page).locator('.merge-pill.rebasing')).toHaveText(
        'Rebasing…',
      );
      await expect(line(page)).toContainText('picked this up');
      await scan();
    });
  });
}

// #787: a queued action on one row holds the whole board (#212), so a row
// whose rebase just landed kept its old "Out of date" data while the same
// snapshot had already moved it to "Rebasing…".
test.describe('bot rebase pickup with another row still queued', () => {
  test('the row that was picked up drops Out of date while the other stays put', async ({
    page,
    request,
    baseURL,
  }) => {
    await registerAndSignIn(page, request, baseURL);
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
    await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowBotPrUpdates: false }),
      }),
    );
    const first = makePR({ number: 42 });
    const second = makePR({ number: 43 });
    const asked = (pr: MockPR, phase: 'queued' | 'rebasing') => ({
      ...pr,
      botRequest: botRequest('dependabot', phase),
    });
    const both = (prs: MockPR[]) => ({
      ...snapshot(prs[0]),
      pullRequests: prs,
    });
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(both([first, second])),
      }),
    );
    await page.route('**/api/pull-requests/dependabot-action', (route: Route) =>
      route.fulfill({ status: 204 }),
    );
    await page.reload();

    const rows = page.locator('#pr-rows .row');
    const rowFor = (n: number) => rows.filter({ hasText: `#${n}` }).first();
    for (const n of [42, 43]) {
      await rowFor(n)
        .getByRole('button', { name: 'Dependabot: Rebase' })
        .click();
      await expect(
        rowFor(n).getByRole('button', { name: 'Rebase requested' }),
      ).toBeVisible();
    }

    // Only the first one was picked up.
    const data = JSON.stringify(
      both([
        { ...asked(first, 'rebasing'), behind: false },
        asked(second, 'queued'),
      ]),
    );
    await page.evaluate((payload) => {
      const w = window as unknown as { __streams: EventSource[] };
      for (const stream of w.__streams)
        stream.onmessage?.(new MessageEvent('message', { data: payload }));
    }, data);

    await expect(rowFor(42).locator('.merge-pill.rebasing')).toHaveText(
      'Rebasing…',
    );
    await expect(rowFor(42).getByText('Out of date')).toHaveCount(0);
    // The other row is untouched, still where it was.
    await expect(rowFor(43).getByText('Out of date')).toBeVisible();
    await expect(rows.nth(0)).toContainText('#42');
    await expect(rows.nth(1)).toContainText('#43');
    await expect(page.locator('#updates-count')).toHaveText('');
  });
});
