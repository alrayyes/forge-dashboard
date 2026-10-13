import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// Hide one pull request, with Undo and a Hidden list (#841). The server owns
// the hiding (POST /api/pull-requests/hide, /unhide, and `hiddenPullRequests`
// plus `includeHidden` on the dashboard), so the page is a stand-in server
// here: it keeps the hidden set and answers the way the real one does.
// https://github.com/alrayyes/forge-dashboard/issues/841

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `hide-pr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Hide PR User');
}

type Hidden = { until: string | null };

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    // Higher numbers are newer, so row 0 is the highest number.
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
    allowedActions: [
      { action: 'merge' },
      { action: 'auto_merge' },
      { action: 'close' },
    ],
    ...overrides,
  };
}

const PRS = [makePR(3), makePR(2), makePR(1)];

// The stand-in server: hides and restores change what the dashboard answers,
// and the posts are recorded so a test can say what was asked.
function standIn(page: Page, initial: Record<number, Hidden> = {}) {
  const hidden = new Map<number, Hidden>(
    Object.entries(initial).map(([n, h]) => [Number(n), h]),
  );
  const posts: { path: string; body: Record<string, unknown> }[] = [];

  const dashboard = (includeHidden: boolean) => ({
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: PRS.filter((p) => includeHidden || !hidden.has(p.number)).map(
      (p) => {
        const h = hidden.get(p.number);
        if (!h) return p;
        return {
          ...p,
          hidden: true,
          ...(h.until ? { hiddenUntil: h.until } : {}),
        };
      },
    ),
    issues: [],
    hiddenPullRequests: hidden.size,
  });

  const answer = (route: Route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        dashboard(url.searchParams.get('includeHidden') === 'true'),
      ),
    });
  };

  return {
    posts,
    hidden,
    async install() {
      await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
      await page.route('**/api/dashboard*', answer);
      await page.route('**/api/dashboard/refresh*', answer);
      await page.route('**/api/pull-requests/hide', (route: Route) => {
        const body = route.request().postDataJSON();
        posts.push({ path: 'hide', body });
        const until = body.days
          ? new Date(Date.now() + body.days * 86_400_000).toISOString()
          : null;
        hidden.set(body.number, { until });
        return route.fulfill({ status: 204 });
      });
      await page.route('**/api/pull-requests/unhide', (route: Route) => {
        const body = route.request().postDataJSON();
        posts.push({ path: 'unhide', body });
        hidden.delete(body.number);
        return route.fulfill({ status: 204 });
      });
    },
  };
}

const rowOf = (page: Page, title: string) =>
  page.locator('#pr-rows .row').filter({ hasText: title });
const rows = (page: Page) => page.locator('#pr-rows .row');

async function open(
  page: Page,
  initial: Record<number, Hidden> = {},
  fakeClock = false,
) {
  const server = standIn(page, initial);
  await server.install();
  // Installed before the page loads so its timers run on the fake clock and a
  // test moves time with runFor instead of sleeping (#1378).
  if (fakeClock) await page.clock.install();
  await page.goto('/pull-requests.html');
  await expect(rows(page).first()).toBeVisible();
  return server;
}

async function menuOf(page: Page, title: string) {
  const row = rowOf(page, title);
  await row.getByRole('button', { name: 'More actions' }).click();
  return row;
}

test.describe('hiding one pull request (#841)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('More actions offers Hide this pull request and Hide for 7 days', async ({
    page,
  }) => {
    await open(page);
    const row = await menuOf(page, 'Pull request 2');

    await expect(
      row.getByRole('button', { name: 'Hide this pull request' }),
    ).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Hide for 7 days' }),
    ).toBeVisible();
  });

  test('Hide posts for that pull request with no days, and the row leaves at once', async ({
    page,
  }) => {
    const server = await open(page);
    const row = await menuOf(page, 'Pull request 2');
    await row.getByRole('button', { name: 'Hide this pull request' }).click();

    await expect(rowOf(page, 'Pull request 2')).toHaveCount(0);
    expect(server.posts).toEqual([
      {
        path: 'hide',
        body: {
          forge: 'github',
          fullName: 'alrayyes/forge-dashboard',
          number: 2,
        },
      },
    ]);
  });

  test('Hide for 7 days posts days: 7', async ({ page }) => {
    const server = await open(page);
    const row = await menuOf(page, 'Pull request 2');
    await row.getByRole('button', { name: 'Hide for 7 days' }).click();

    await expect(rowOf(page, 'Pull request 2')).toHaveCount(0);
    expect(server.posts[0].body.days).toBe(7);
  });

  test('a status message says what was hidden and has a focusable Undo, and it does not go away', async ({
    page,
  }) => {
    await open(page, {}, true);
    const row = await menuOf(page, 'Pull request 2');
    await row.getByRole('button', { name: 'Hide this pull request' }).click();

    const status = page.locator('#hide-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toContainText('Hid PR #2 ‘Pull request 2’.');
    const undo = status.getByRole('button', { name: 'Undo' });
    await undo.focus();
    await expect(undo).toBeFocused();

    // Longer than a toast lives (6 s): this message is not a toast and stays.
    await page.clock.runFor(10_000);
    await expect(status).toContainText('Hid PR #2');
  });

  test('Undo brings the row back', async ({ page }) => {
    const server = await open(page);
    const row = await menuOf(page, 'Pull request 2');
    await row.getByRole('button', { name: 'Hide this pull request' }).click();
    await expect(rowOf(page, 'Pull request 2')).toHaveCount(0);

    await page
      .locator('#hide-status')
      .getByRole('button', { name: 'Undo' })
      .click();

    await expect(rowOf(page, 'Pull request 2')).toHaveCount(1);
    expect(server.posts.map((p) => p.path)).toEqual(['hide', 'unhide']);
    await expect(page.locator('#hide-status')).toContainText('Restored PR #2');
  });

  test('with nothing hidden there is no Hidden link', async ({ page }) => {
    await open(page);

    await expect(page.locator('#hidden-prs-toggle')).toBeHidden();
  });

  test('hiding makes a Hidden (N) link appear, counting what the server counts', async ({
    page,
  }) => {
    await open(page);
    const row = await menuOf(page, 'Pull request 2');
    await row.getByRole('button', { name: 'Hide this pull request' }).click();

    await expect(page.locator('#hidden-prs-toggle')).toHaveText('Hidden (1)');
  });
});

test.describe('the Hidden list (#841)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  const in6Days = () => new Date(Date.now() + 5.2 * 86_400_000).toISOString();

  test('opens a list with repo, number, title and when each comes back', async ({
    page,
  }) => {
    await open(page, { 1: { until: null }, 2: { until: in6Days() } });
    await page.locator('#hidden-prs-toggle').click();

    const list = page.locator('#hidden-prs-list');
    await expect(list.locator('li')).toHaveCount(2);
    const forever = list.locator('li').filter({ hasText: 'Pull request 1' });
    await expect(forever).toContainText('alrayyes/forge-dashboard');
    await expect(forever).toContainText('#1');
    await expect(forever).toContainText('Hidden until you restore it');
    await expect(
      list.locator('li').filter({ hasText: 'Pull request 2' }),
    ).toContainText('Back in 6 days');
  });

  test('the toggle says whether the list is open', async ({ page }) => {
    await open(page, { 1: { until: null } });
    const toggle = page.locator('#hidden-prs-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('Restore posts for that pull request and the row returns', async ({
    page,
  }) => {
    const server = await open(page, { 1: { until: null } });
    await expect(rowOf(page, 'Pull request 1')).toHaveCount(0);
    await page.locator('#hidden-prs-toggle').click();

    await page
      .locator('#hidden-prs-list li')
      .filter({ hasText: 'Pull request 1' })
      .getByRole('button', { name: /Restore/ })
      .click();

    await expect(rowOf(page, 'Pull request 1')).toHaveCount(1);
    expect(server.posts).toEqual([
      {
        path: 'unhide',
        body: {
          forge: 'github',
          fullName: 'alrayyes/forge-dashboard',
          number: 1,
        },
      },
    ]);
  });

  test('restoring the last one removes the link', async ({ page }) => {
    await open(page, { 1: { until: null } });
    await page.locator('#hidden-prs-toggle').click();
    await page
      .locator('#hidden-prs-list li')
      .getByRole('button', { name: /Restore/ })
      .click();

    await expect(page.locator('#hidden-prs-toggle')).toBeHidden();
  });

  test('a Restore button names the pull request it restores', async ({
    page,
  }) => {
    await open(page, { 1: { until: null } });
    await page.locator('#hidden-prs-toggle').click();

    await expect(
      page.getByRole('button', { name: 'Restore PR #1 ‘Pull request 1’' }),
    ).toBeVisible();
  });
});

test.describe('hiding is accessible (#841)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

  for (const scheme of ['light', 'dark'] as const) {
    test(`the menu items, the status message and the Hidden list have no axe violations (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, { 1: { until: null } });
      const row = await menuOf(page, 'Pull request 2');
      expect(
        (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
      ).toEqual([]);

      await row.getByRole('button', { name: 'Hide this pull request' }).click();
      await page.locator('#hidden-prs-toggle').click();
      await expect(page.locator('#hidden-prs-list li')).toHaveCount(2);
      expect(
        (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
      ).toEqual([]);
    });
  }

  test('the Undo, toggle and Restore targets are at least 24px', async ({
    page,
  }) => {
    await open(page, { 1: { until: null } });
    const row = await menuOf(page, 'Pull request 2');
    await row.getByRole('button', { name: 'Hide this pull request' }).click();
    await page.locator('#hidden-prs-toggle').click();

    const targets = [
      page.locator('#hide-status').getByRole('button', { name: 'Undo' }),
      page.locator('#hidden-prs-toggle'),
      page.locator('#hidden-prs-list').getByRole('button').first(),
    ];
    for (const target of targets) {
      const box = await target.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(24);
      expect(box?.height).toBeGreaterThanOrEqual(24);
    }
  });
});
