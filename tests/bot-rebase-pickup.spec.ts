import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

// #707: after a Dependabot or Renovate rebase request the row says the
// request went out, that the bot picks it up in its own time, and when it
// has. The wait is on the bot, not on the dashboard's own refresh, so the
// copy says so; the "Requested Ns ago" ticker stays out of the announced
// text the same way the refresh countdown does (#714).
//
// Pickup is read from snapshots alone: the pull request is no longer
// behind its base (the bot rebased it), and the "Rebasing…" pill stays
// until CI shows as restarted.

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
    pr: makePR(),
    endpoint: '**/api/pull-requests/dependabot-action',
    button: 'Dependabot: Rebase',
    requested: 'Dependabot will pick this up shortly.',
    detail: 'This can take a few minutes, no need to click again.',
  },
  {
    bot: 'Renovate',
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
      await page.route(b.endpoint, (route: Route) =>
        route.fulfill({ status: 204 }),
      );
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

    test('after two minutes the line says it is normal and links to the pull request', async ({
      page,
    }) => {
      await request(page);
      await skew(page, 119_000);
      await expect(line(page)).toContainText(b.requested);
      await expect(line(page)).not.toContainText('Still waiting');

      await skew(page, 3 * 60_000 + 1_000);
      await expect(line(page)).toContainText(
        `Still waiting on ${b.bot} (3m). It queues requests, this is normal.`,
      );
      await expect(line(page)).not.toContainText(b.requested);
      const link = line(page).getByRole('link', { name: /pull request/i });
      await expect(link).toHaveAttribute('href', b.pr.url);
      await expect(link).toContainText('GitHub');
    });

    test('the requested and slow lines survive a stream push that shows no pickup', async ({
      page,
    }) => {
      await request(page);
      await skew(page, 3 * 60_000);
      await expect(line(page)).toContainText('Still waiting');
      await push(page, current);
      await page.waitForTimeout(500);
      await expect(line(page)).toContainText(`Still waiting on ${b.bot}`);
      await expect(
        row(page).getByRole('button', { name: 'Rebase requested' }),
      ).toBeDisabled();
      await expect(
        page.locator('#feedback-toasts .feedback-toast'),
      ).toHaveCount(1);
    });

    test('once the bot has rebased it the row says Rebasing… until CI restarts', async ({
      page,
    }) => {
      await request(page);
      // The bot force-pushed: no longer behind, CI not restarted yet.
      current = { ...current, behind: false };
      await push(page, current);

      const pill = row(page).locator('.merge-pill.rebasing');
      await expect(pill).toHaveText('Rebasing…');
      await expect(row(page).getByText('Out of date')).toHaveCount(0);
      await expect(line(page)).toContainText(`${b.bot} picked this up`);
      await expect(line(page)).not.toContainText(/Requested \d+s ago/);
      await expect(page.locator('#feedback-live')).toContainText(
        `${b.bot} picked up the rebase`,
      );

      // CI restarts: the pill and the line are done.
      current = { ...current, ci: 'pending' };
      await push(page, current);
      await expect(row(page).locator('.merge-pill.rebasing')).toHaveCount(0);
      await expect(line(page)).toHaveCount(0);
      await expect(
        page.locator('#feedback-toasts .feedback-toast').first(),
      ).toContainText(`${b.bot} rebase finished.`);
    });

    test('a repo whose CI never restarts does not keep Rebasing… forever', async ({
      page,
    }) => {
      await request(page);
      current = { ...current, behind: false };
      await push(page, current);
      await expect(row(page).locator('.merge-pill.rebasing')).toBeVisible();

      await skew(page, 2 * 60_000 + 5_000);
      await push(page, current);
      await expect(row(page).locator('.merge-pill.rebasing')).toHaveCount(0);
      await expect(line(page)).toHaveCount(0);
    });

    test('a CI run already under way at pickup needs no Rebasing… step', async ({
      page,
    }) => {
      await request(page);
      current = { ...current, behind: false, ci: 'pending' };
      await push(page, current);
      await expect(row(page).locator('.merge-pill.rebasing')).toHaveCount(0);
      await expect(
        page.locator('#feedback-toasts .feedback-toast').first(),
      ).toContainText(`${b.bot} rebase finished.`);
    });

    test('has no axe violations when requested, slow or rebasing, and none relies on colour alone', async ({
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

      await skew(page, 3 * 60_000);
      await expect(line(page)).toContainText('Still waiting');
      await scan();

      current = { ...current, behind: false };
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
    const data = JSON.stringify(both([{ ...first, behind: false }, second]));
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
