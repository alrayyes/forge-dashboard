import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { rateLimit } from './severity-stand-in';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The tests mock /api/dashboard and write nothing per user, so they start from
// the shared session instead of registering a user each (#1379).
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

// #756: while a forge is rate limited (read-only, #755), a behind pull
// request can queue Update branch (or a bot rebase) to run at the reset. The
// server keeps the queue (api/openapi.yaml, /api/queued-actions); the page
// offers the control, shows the queued line with Cancel, lists the item in
// Activity, and says when it ran or why it didn't. Merge and Close are never
// queueable.

type Queued = {
  id: string;
  action: string;
  forge: string;
  fullName: string;
  number: number;
  status: 'queued' | 'done' | 'skipped' | 'failed';
  runAt: string;
  createdAt: string;
  finishedAt?: string;
  code?: string;
  message?: string;
};

const RESET = new Date(Date.now() + 20 * 60_000).toISOString();

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: true,
    kind: 'regular',
    ...overrides,
  };
}

const limited = () => ({
  forge: 'github',
  reachable: true,
  repoCount: 1,
  rateLimitREST: rateLimit(5000, 0, RESET),
  rateLimitGraphQL: rateLimit(5000, 0, RESET),
});
const healthy = () => ({ forge: 'github', reachable: true, repoCount: 1 });

type State = { queuedActions: Queued[]; posts: unknown[]; deletes: string[] };

// Mocks the snapshot with the queue riding along, and the three queue calls.
async function setup(
  page: Page,
  forge: Record<string, unknown>,
  pr: Record<string, unknown>,
) {
  const state: State = { queuedActions: [], posts: [], deletes: [] };
  const snapshot = () =>
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: [forge],
      pullRequests: [
        {
          ...pr,
          queued:
            state.queuedActions.find(
              (q) => q.status === 'queued' && q.number === pr.number,
            ) ?? null,
        },
      ],
      issues: [],
      queuedActions: state.queuedActions,
    });
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route(/\/api\/dashboard(\/refresh)?(\?.*)?$/, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    }),
  );
  await page.route('**/api/queued-actions', (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    state.posts.push(body);
    const item: Queued = {
      id: 'q1',
      action: body.action,
      forge: body.forge,
      fullName: body.fullName,
      number: body.number,
      status: 'queued',
      runAt: RESET,
      createdAt: new Date().toISOString(),
    };
    state.queuedActions = [item];
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(item),
    });
  });
  await page.route('**/api/queued-actions/*', (route: Route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    state.deletes.push(route.request().url().split('/').pop() ?? '');
    state.queuedActions = [];
    return route.fulfill({ status: 204 });
  });
  return state;
}

const row = (page: Page) => page.locator('#pr-rows .row').first();
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('queue a safe action for the rate limit reset (#756)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pull-requests.html');
  });

  test('a behind pull request on a limited forge offers Queue for the reset, never Merge or Close', async ({
    page,
  }) => {
    await setup(page, limited(), makePR());
    await page.reload();

    await expect(
      row(page).getByRole('button', {
        name: /^Queue update for \d{1,2}:\d{2}/,
      }),
    ).toBeVisible();
    for (const name of ['Merge', 'Close', 'Update branch'])
      await expect(
        row(page).getByRole('button', { name, exact: true }),
      ).toHaveCount(0);
    await expect(
      row(page).getByRole('button', { name: /Queue .*(merge|close)/i }),
    ).toHaveCount(0);
  });

  test('queueing stores it, and the row says it is queued with Cancel, and Activity lists it', async ({
    page,
  }) => {
    const state = await setup(page, limited(), makePR());
    await page.reload();

    await row(page)
      .getByRole('button', { name: /^Queue update for/ })
      .click();

    await expect.poll(() => state.posts.length).toBe(1);
    expect(state.posts[0]).toEqual({
      action: 'update_branch',
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 42,
    });
    // The row's waiting chip (#1229) carries it, with Cancel inside.
    const chip = row(page).locator('.wait-chip');
    await expect(chip.locator('.wait-chip-label')).toHaveText(
      /^Queued · \d{1,2}:\d{2}$/,
    );
    await expect(chip.locator('.wait-chip-detail')).toContainText(/Resets in/);
    await expect(
      chip.getByRole('button', { name: /^Cancel queued update for/ }),
    ).toBeVisible();
    await expect(
      row(page).getByRole('button', { name: /^Queue update for/ }),
    ).toHaveCount(0);

    await page.locator('#activity-toggle').click();
    await expect(page.locator('#activity-panel')).toContainText(
      'alrayyes/forge-dashboard#42',
    );
    await expect(page.locator('#activity-panel')).toContainText(
      /Update branch queued for/,
    );
  });

  test('Cancel removes it and the control returns', async ({ page }) => {
    const state = await setup(page, limited(), makePR());
    await page.reload();
    await row(page)
      .getByRole('button', { name: /^Queue update for/ })
      .click();
    await expect(row(page).locator('.wait-chip')).toBeVisible();

    await row(page)
      .getByRole('button', { name: /^Cancel queued update/ })
      .click();

    await expect.poll(() => state.deletes).toEqual(['q1']);
    await expect(row(page).locator('.wait-chip')).toHaveCount(0);
    await expect(
      row(page).getByRole('button', { name: /^Queue update for/ }),
    ).toBeVisible();
  });

  test('a bot pull request queues its rebase', async ({ page }) => {
    // Which page lists it doesn't matter here; what the server offers does.
    const state = await setup(
      page,
      limited(),
      makePR({
        author: 'dependabot',
        title: 'Bump foo from 1 to 2',
        allowedActions: [{ action: 'dependabot_rebase' }],
      }),
    );
    await page.reload();

    await row(page)
      .getByRole('button', { name: /^Queue rebase for \d/ })
      .click();
    await expect.poll(() => state.posts.length).toBe(1);
    expect(state.posts[0]).toMatchObject({ action: 'dependabot_rebase' });
  });

  test('it is not offered where the action isn’t: a forge with budget, a pull request that is not behind', async ({
    page,
  }) => {
    await setup(page, healthy(), makePR());
    await page.reload();
    await expect(row(page).getByRole('button', { name: /^Queue/ })).toHaveCount(
      0,
    );
    await expect(
      row(page).getByRole('button', { name: 'Update branch' }),
    ).toBeVisible();

    await setup(page, limited(), makePR({ behind: false }));
    await page.reload();
    await expect(row(page).getByRole('button', { name: /^Queue/ })).toHaveCount(
      0,
    );
  });

  test('an outcome arrives as a polite toast and stays in Activity, with why when it was skipped', async ({
    page,
  }) => {
    const state = await setup(page, limited(), makePR());
    await page.reload();
    await expect(
      row(page).getByRole('button', { name: /^Queue update for/ }),
    ).toBeVisible();

    state.queuedActions = [
      {
        id: 'q9',
        action: 'update_branch',
        forge: 'github',
        fullName: 'alrayyes/forge-dashboard',
        number: 42,
        status: 'skipped',
        runAt: RESET,
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        code: 'already_merged',
        message: 'Already merged',
      },
    ];
    await page.locator('#force-refresh-button').click();

    await expect(
      page.locator('#feedback-toasts .feedback-toast'),
    ).toContainText('Already merged');
    await expect(page.locator('#feedback-live')).toContainText(
      'Already merged',
    );
    await page.locator('#activity-toggle').click();
    await expect(page.locator('#activity-panel')).toContainText(
      /Update branch skipped: Already merged/,
    );
  });

  test('has no axe-core violations queued, with Activity open, at desktop and 375px', async ({
    page,
  }) => {
    await setup(page, limited(), makePR());
    await page.reload();
    await row(page)
      .getByRole('button', { name: /^Queue update for/ })
      .click();
    await expect(row(page).locator('.wait-chip')).toBeVisible();
    await page.locator('#activity-toggle').click();

    expect(
      (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations,
    ).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    expect(
      (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations,
    ).toEqual([]);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
