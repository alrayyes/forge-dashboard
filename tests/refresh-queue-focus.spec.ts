import { expect, type Page, type Route } from '@playwright/test';
import { rateLimit } from './rate-limit-mock';
import { test } from './server-fixture';

// #3289: Refresh now and Queue update for <time> kept a native `disabled`
// while their request ran, which drops keyboard focus to BODY (#690). Each
// stays focusable (aria-disabled), a second press sends nothing, and focus is
// never on BODY. Focus is sampled at f0 before the press, f1 while the request
// is pending, f2 at the reply, f3 once the page settled.

const RESET = new Date(Date.now() + 20 * 60_000).toISOString();
const now = new Date().toISOString();

type Sample = { tag: string; text: string; id: string };

const sample = (page: Page): Promise<Sample> =>
  page.evaluate(() => {
    const a = document.activeElement;
    return {
      tag: a?.tagName ?? '',
      text: (a?.textContent ?? '').trim().slice(0, 40),
      id: a?.id ?? '',
    };
  });

const pr = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 42,
  title: 'A pull request',
  url: 'https://example.com/42',
  author: 'ryankes',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: now,
  updatedAt: now,
  mergeStatus: 'mergeable',
  behind: true,
  kind: 'regular',
};

const limited = {
  forge: 'github',
  reachable: true,
  repoCount: 1,
  rateLimitREST: rateLimit(5000, 0, RESET),
  rateLimitGraphQL: rateLimit(5000, 0, RESET),
};

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

const snapshot = (queued: unknown = null) =>
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    forges: [limited],
    pullRequests: [{ ...pr, queued }],
    issues: [],
    queuedActions: queued ? [queued] : [],
  });

test.describe('Refresh now keeps focus (#3289)', () => {
  for (const retryAfter of [undefined, 2]) {
    test(`Enter, Enter sends one refresh and focus is never BODY, ${retryAfter ? `cooldown ${retryAfter}s` : '200'}`, async ({
      page,
    }) => {
      const g = gate();
      let posts = 0;
      let replied = false;
      await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
      await page.route(/\/api\/v1\/dashboard(\?.*)?$/, (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: snapshot(),
        }),
      );
      await page.goto('/pull-requests.html');
      await expect(page.locator('#pr-rows .row').first()).toBeVisible();
      await page.route(
        /\/api\/v1\/dashboard\/refresh(\?.*)?$/,
        async (route: Route) => {
          posts++;
          await g.promise;
          replied = true;
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: retryAfter ? { 'Retry-After': String(retryAfter) } : {},
            body: snapshot(),
          });
        },
      );
      const button = page.locator('#force-refresh-button');
      await button.focus();
      const f0 = await sample(page);
      await page.keyboard.press('Enter');
      await expect.poll(() => posts).toBe(1);
      const f1 = await sample(page);
      await page.keyboard.press('Enter');
      g.release();
      await expect.poll(() => replied).toBe(true);
      const f2 = await sample(page);
      await expect(button).not.toHaveClass(/is-refreshing/);
      // Inside a cooldown the button stays locked, still focused.
      if (retryAfter)
        await expect(button).toHaveAttribute('aria-disabled', 'true');
      const f3 = await sample(page);
      const trace = JSON.stringify({ f0, f1, f2, f3 });
      for (const s of [f0, f1, f2, f3]) {
        expect(s.tag, trace).not.toBe('BODY');
        expect(s.id, trace).toBe('force-refresh-button');
      }
      expect(posts).toBe(1);
      if (retryAfter) {
        // A press inside the cooldown sends nothing; once it ends, the
        // button is free again and still focused.
        await page.keyboard.press('Enter');
        expect(posts).toBe(1);
        await expect(button).not.toHaveAttribute('aria-disabled', 'true', {
          timeout: 5000,
        });
        expect((await sample(page)).id, trace).toBe('force-refresh-button');
      }
    });
  }
});

test.describe('Queue update keeps focus (#3289)', () => {
  for (const status of [201, 500]) {
    test(`Enter, Enter sends one request and focus is never BODY, reply ${status}`, async ({
      page,
    }) => {
      const g = gate();
      let posts = 0;
      let replied = false;
      let queued: unknown = null;
      await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
      await page.route(
        /\/api\/v1\/dashboard(\/refresh)?(\?.*)?$/,
        (route: Route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: snapshot(queued),
          }),
      );
      await page.route('**/api/v1/queued-actions', async (route: Route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        posts++;
        await g.promise;
        replied = true;
        if (status === 500)
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'boom', code: 'internal' }),
          });
        const body = route.request().postDataJSON();
        queued = {
          id: 'q1',
          action: body.action,
          forge: body.forge,
          fullName: body.fullName,
          number: body.number,
          status: 'queued',
          runAt: RESET,
          createdAt: new Date().toISOString(),
        };
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(queued),
        });
      });
      await page.goto('/pull-requests.html');
      const row = page.locator('#pr-rows .row').first();
      const button = row.getByRole('button', { name: /^Queue update for/ });
      await expect(button).toBeVisible();
      await button.focus();
      const f0 = await sample(page);
      await page.keyboard.press('Enter');
      await expect.poll(() => posts).toBe(1);
      const f1 = await sample(page);
      await page.keyboard.press('Enter');
      g.release();
      await expect.poll(() => replied).toBe(true);
      const f2 = await sample(page);
      if (status === 500) {
        await expect(button).not.toHaveAttribute('aria-disabled', 'true');
      } else {
        await expect(
          row.getByRole('button', { name: /^Cancel/ }),
        ).toBeVisible();
      }
      const f3 = await sample(page);
      const trace = JSON.stringify({ f0, f1, f2, f3 });
      for (const s of [f0, f1, f2, f3]) expect(s.tag, trace).not.toBe('BODY');
      expect(posts).toBe(1);
      if (status === 500) expect(f3.text, trace).toMatch(/^Queue update for/);
    });
  }
});
