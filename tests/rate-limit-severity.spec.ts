import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { rateLimit } from './severity-stand-in';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The tests mock /api/dashboard and write nothing per user, so they start from
// the shared session instead of registering a user each (#1379).
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

// #806: the banner reads each rate limit's `severity` from the server, and a
// locked action offers Retry from the refusal's `code`, not from the words in
// its message. The mocks below state `severity` and `code` so they disagree
// with what the page used to work out itself.

const FUTURE = () => new Date(Date.now() + 20 * 60_000).toISOString();

async function open(
  page: Page,
  health: Record<string, unknown>,
  prs: Record<string, unknown>[] = [],
) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1, ...health }],
        pullRequests: prs,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
}

test.describe('rate limits follow the server (#806)', () => {
  test('severity exceeded shows the banner even when the numbers look healthy', async ({
    page,
  }) => {
    await open(page, {
      rateLimitREST: {
        limit: 5000,
        remaining: 4000,
        resetsAt: FUTURE(),
        severity: 'exceeded',
      },
    });
    await expect(page.locator('#rate-limit-banner')).toContainText(
      'GitHub is rate limited',
    );
  });

  test('severity low shows the running-low banner', async ({ page }) => {
    await open(page, {
      rateLimitGraphQL: {
        limit: 5000,
        remaining: 4000,
        resetsAt: FUTURE(),
        severity: 'low',
      },
    });
    await expect(page.locator('#rate-limit-banner')).toContainText(
      'Rate limit running low',
    );
  });

  test('severity ok shows no banner even when the numbers look nearly spent', async ({
    page,
  }) => {
    await open(page, {
      rateLimitREST: {
        limit: 5000,
        remaining: 10,
        resetsAt: FUTURE(),
        severity: 'ok',
      },
    });
    await expect(page.locator('#pr-rows')).toBeAttached();
    await expect(page.locator('#rate-limit-banner')).toHaveCount(0);
  });

  test('a coded refusal offers Retry whatever words its message holds', async ({
    page,
  }) => {
    await page.route('**/api/pull-requests/update-branch', (route: Route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'x',
          code: 'conflict',
          // Mentions a rate limit, but the code says it isn't one.
          message: 'Hit a rate limit of conflicting changes',
        }),
      }),
    );
    await open(page, {}, [
      {
        forge: 'github',
        repo: 'alrayyes/forge-dashboard',
        number: 42,
        title: 'Behind',
        url: 'https://example.com/42',
        author: 'claude',
        draft: false,
        ci: 'success',
        labels: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        mergeStatus: 'blocked',
        behind: true,
      },
    ]);

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Update branch' }).click();
    await expect(row).toContainText('Hit a rate limit of conflicting changes');
    await expect(
      row.getByRole('button', { name: /Retry/ }).first(),
    ).toBeVisible();
  });
});

// #1791: a low budget moves on every poll. The banner node must stay put so a
// screen reader isn't told again each time, while the visible count follows.
test.describe('a low rate limit banner stays put while the count moves (#1791)', () => {
  type State = { remaining: number; requests: number; exhausted: boolean };

  async function openLow(page: Page, state: State) {
    await page.clock.install();
    await page.route('**/api/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    // One window: the reset time holds still while the count falls.
    const resetsAt = new Date(Date.now() + 20 * 60_000).toISOString();
    await page.route('**/api/dashboard*', (route: Route) => {
      state.requests++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            {
              forge: 'github',
              reachable: true,
              repoCount: 1,
              rateLimitREST: rateLimit(
                5000,
                state.exhausted ? 0 : state.remaining,
                resetsAt,
              ),
            },
          ],
          pullRequests: [],
          issues: [],
          repos: [],
          hiddenDrafts: 0,
        }),
      });
    });
    await page.goto('/pull-requests.html');
    await expect(page.locator('#rate-limit-banner')).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __bannerNode: Element | null };
      w.__bannerNode = document.getElementById('rate-limit-banner');
      // A rebuilt banner is a new node, so identity says whether it was.
    });
  }

  async function poll(page: Page, state: State) {
    const before = state.requests;
    for (let i = 0; i < 60 && state.requests === before; i++) {
      await page.clock.runFor(1000);
      await page.waitForTimeout(25);
    }
    expect(state.requests).toBeGreaterThan(before);
    await page.waitForTimeout(150);
  }

  test('the same node serves several polls and the number updates in place', async ({
    page,
  }) => {
    const state: State = { remaining: 200, requests: 0, exhausted: false };
    await openLow(page, state);
    const banner = page.locator('#rate-limit-banner');
    await expect(banner).toContainText('200 of 5,000');
    for (let i = 0; i < 3; i++) {
      state.remaining -= 10;
      await poll(page, state);
    }
    await expect(banner).toContainText('170 of 5,000');
    const result = await page.evaluate(() => {
      const w = window as unknown as {
        __bannerNode: Element | null;
      };
      return {
        same: w.__bannerNode === document.getElementById('rate-limit-banner'),
      };
    });
    expect(result.same).toBe(true);
    // A low budget is a status, not an alarm.
    await expect(banner).toHaveAttribute('role', 'status');
    // The spoken text names the reset time, and the moving count stays
    // out of it.
    await expect(banner.locator('.rate-limit-banner-timer')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    await expect(banner.locator('.rate-limit-banner-label')).toContainText(
      'Rate limit running low',
    );
  });

  test('crossing to exhausted announces again, assertively', async ({
    page,
  }) => {
    const state: State = { remaining: 200, requests: 0, exhausted: false };
    await openLow(page, state);
    state.exhausted = true;
    await poll(page, state);
    const banner = page.locator('#rate-limit-banner');
    await expect(banner).toContainText('GitHub is rate limited');
    await expect(banner).toHaveAttribute('role', 'alert');
  });
});
