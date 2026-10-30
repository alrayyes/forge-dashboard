import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// The skeleton shows from the first paint, not once the first answer lands.
// The server holds GET /api/v1/dashboard for up to 15 s on a cold start, and
// until then the page used to be blank.
// https://github.com/alrayyes/forge-dashboard/issues/1672

function pr(number: number) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pulls/${number}`,
    author: 'claude',
    kind: 'regular',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: false,
  };
}

type Answer = {
  done?: boolean;
  withItems?: boolean;
  generatedAt?: string;
  readIntervalSeconds?: number;
};

function snapshot(a: Answer) {
  const prs = a.withItems ? [pr(1)] : [];
  const body: Record<string, unknown> = {
    generatedAt: a.generatedAt ?? new Date().toISOString(),
    readIntervalSeconds: a.readIntervalSeconds ?? 30,
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: prs,
    issues: [],
    repos: [],
    hiddenDrafts: 0,
    navCounts: navCountsFor(prs, 0),
  };
  if (a.done !== undefined) body.firstRefreshDone = a.done;
  return JSON.stringify(body);
}

// Holds every /api/v1/dashboard answer until `release()` is called, then
// answers `after`.
async function holdFirstAnswer(page: Page, after: Answer) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', async (route: Route) => {
    if (new URL(route.request().url()).pathname !== '/api/v1/dashboard')
      return route.fallback();
    await gate;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(after),
    });
  });
  return release;
}

const navPills = (page: Page) =>
  page.getByRole('navigation', { name: 'Main' }).locator('.nav-total');

const LISTS = [
  {
    name: 'Pull requests',
    url: '/pull-requests.html',
    emptyText: /No open pull requests/,
  },
  {
    name: 'Releases',
    url: '/releases.html',
    emptyText: /No release pull requests are open/,
  },
  {
    name: 'Bots',
    url: '/bots.html',
    emptyText: /No bot pull requests are open/,
  },
  { name: 'Issues', url: '/issues.html', emptyText: /No open issues/ },
];

test.describe('first refresh loading from the first paint (#1672)', () => {
  for (const list of LISTS) {
    test(`${list.name} shows the loading state while the first answer is held`, async ({
      page,
    }) => {
      const release = await holdFirstAnswer(page, {
        done: true,
        withItems: false,
      });
      await page.goto(list.url);

      // Nothing has answered yet.
      const region = page.locator('.list-region');
      await expect(region).toHaveAttribute('aria-busy', 'true');
      await expect(region.getByTestId('list-skeleton')).toBeVisible();
      await expect(page.getByTestId('first-refresh-status')).toHaveText(
        'Loading your repositories…',
      );
      await expect(page.getByText(list.emptyText)).toBeHidden();
      for (const text of await navPills(page).allTextContents())
        expect(text.trim()).toBe('–');

      release();
      await expect(page.getByText(list.emptyText)).toBeVisible();
      await expect(region).not.toHaveAttribute('aria-busy', /.*/);
      await expect(page.getByTestId('first-refresh-status')).toHaveText('');
    });
  }

  test('Branches shows the loading state while the first answer is held', async ({
    page,
  }) => {
    const release = await holdFirstAnswer(page, { done: true });
    await page.goto('/');
    await expect(page.locator('.list-region')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(page.getByTestId('first-refresh-status')).toHaveText(
      'Loading your repositories…',
    );
    await expect(page.getByTestId('no-repos')).toBeHidden();
    release();
    await expect(page.getByTestId('no-repos')).toBeVisible();
  });

  test('a held answer of true brings the rows in', async ({ page }) => {
    const release = await holdFirstAnswer(page, {
      done: true,
      withItems: true,
    });
    await page.goto('/pull-requests.html');
    await expect(page.getByTestId('list-skeleton')).toBeVisible();
    await expect(page.locator('#pr-rows .row')).toBeHidden();
    release();
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    await expect(page.getByTestId('list-skeleton')).toHaveCount(0);
  });

  test('a held answer of false keeps the skeleton', async ({ page }) => {
    const release = await holdFirstAnswer(page, { done: false });
    await page.goto('/pull-requests.html');
    await expect(page.getByTestId('list-skeleton')).toBeVisible();
    release();
    await expect(page.locator('.list-region')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(page.getByTestId('list-skeleton')).toBeVisible();
    await expect(page.getByText(/No open pull requests/)).toBeHidden();
  });

  test('a warm load flashes no skeleton and announces nothing', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __seen: string[] };
      w.__seen = [];
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="list-skeleton"]'))
          w.__seen.push('skeleton');
        if (document.querySelector('[aria-busy="true"]')) w.__seen.push('busy');
        const status = document.querySelector(
          '[data-testid="first-refresh-status"]',
        );
        if (status?.textContent?.trim()) w.__seen.push('status');
      }).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    // The page clock is faked so the late timer runs when the test says,
    // not after a guessed real-time pause.
    // install() alone lets the fake clock tick with real time, so on a busy
    // host the skeleton's show delay can expire before the answer lands. Stop
    // it, so the page is "warm" by construction and only runFor() moves time.
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
    const release = await holdFirstAnswer(page, {
      done: true,
      withItems: true,
    });
    release();
    await page.goto('/pull-requests.html');
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    // Let any late timer run, then check nothing ever showed.
    await page.clock.runFor(2000);
    expect(
      await page.evaluate(
        () => (window as unknown as { __seen: string[] }).__seen,
      ),
    ).toEqual([]);
  });

  test('a failed first request settles to the real state and does not hang', async ({
    page,
  }) => {
    await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    await page.route('**/api/v1/dashboard*', (route: Route) =>
      new URL(route.request().url()).pathname === '/api/v1/dashboard'
        ? route.abort()
        : route.fallback(),
    );
    await page.goto('/pull-requests.html');
    await expect(page.getByTestId('list-skeleton')).toHaveCount(0);
    await expect(page.getByTestId('first-refresh-status')).toHaveText('');
    await expect(page.locator('.list-region')).not.toHaveAttribute(
      'aria-busy',
      /.*/,
    );
  });

  test('the zero time shows no "Refreshed ... ago", a real one does', async ({
    page,
  }) => {
    const zero = '0001-01-01T00:00:00Z';
    let answer: Answer = {
      done: false,
      generatedAt: zero,
      readIntervalSeconds: 1,
    };
    await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    await page.route('**/api/v1/dashboard*', (route: Route) =>
      new URL(route.request().url()).pathname === '/api/v1/dashboard'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: snapshot(answer),
          })
        : route.fallback(),
    );
    await page.goto('/pull-requests.html');
    const refreshed = page.locator('.refreshed');
    await expect(page.getByTestId('list-skeleton')).toBeVisible();
    await expect(refreshed).toBeHidden();

    // Done, but still the zero time: still nothing to show.
    answer = { done: true, generatedAt: zero, readIntervalSeconds: 1 };
    await expect(page.getByTestId('list-skeleton')).toHaveCount(0);
    await expect(refreshed).toBeHidden();
    await expect(page.locator('body')).not.toContainText(/\d{4,}d ago/);

    answer = { done: true, readIntervalSeconds: 1 };
    await expect(refreshed).toBeVisible();
    await expect(page.locator('#refreshed-at')).toHaveText('just now');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`pending at 360px in the ${scheme} scheme passes axe after the content assertions`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 360, height: 740 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await holdFirstAnswer(page, { done: true });
      await page.goto('/pull-requests.html');
      await expect(page.getByTestId('list-skeleton')).toBeVisible();
      await expect(page.getByTestId('first-refresh-status')).toHaveText(
        'Loading your repositories…',
      );
      expect(
        await page
          .locator('.skeleton-bar')
          .first()
          .evaluate((el) => getComputedStyle(el).animationName),
      ).toBe('none');
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('the page re-reads after the advised interval and swaps the skeleton for rows', async ({
    page,
  }) => {
    await page.clock.install();
    let reads = 0;
    await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    await page.route('**/api/v1/dashboard*', (route: Route) => {
      if (new URL(route.request().url()).pathname !== '/api/v1/dashboard')
        return route.fallback();
      reads++;
      const body =
        reads === 1
          ? snapshot({ done: false, readIntervalSeconds: 2 })
          : snapshot({ done: true, withItems: true, readIntervalSeconds: 30 });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body,
      });
    });
    await page.goto('/pull-requests.html');
    await expect(page.getByTestId('list-skeleton')).toBeVisible();
    expect(reads).toBe(1);

    // Short of the advised 2 s: no second read.
    await page.clock.runFor(1500);
    expect(reads).toBe(1);
    await page.clock.runFor(700);
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    expect(reads).toBe(2);
    await expect(page.getByTestId('list-skeleton')).toHaveCount(0);
  });

  test('only one /api/v1/dashboard request is in flight while the first answer is held', async ({
    page,
  }) => {
    await page.clock.install();
    let reads = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    await page.route('**/api/v1/dashboard*', async (route: Route) => {
      if (new URL(route.request().url()).pathname !== '/api/v1/dashboard')
        return route.fallback();
      reads++;
      await gate;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: snapshot({ done: false, readIntervalSeconds: 2 }),
      });
    });
    await page.goto('/pull-requests.html');
    await expect.poll(() => reads).toBe(1);
    // Past the old 10 s default, within the 15 s the server holds a read: the
    // poll has not started, so no second held request joined the first.
    await page.clock.runFor(14_000);
    expect(reads).toBe(1);

    // The first answer arms the poll, after the interval it advised.
    release();
    await expect(page.getByTestId('list-skeleton')).toBeVisible();
    await page.clock.runFor(1500);
    expect(reads).toBe(1);
    await page.clock.runFor(700);
    await expect.poll(() => reads).toBe(2);
  });

  test('a poll held by the server is not joined by more, and the next one follows its answer', async ({
    page,
  }) => {
    await page.clock.install();
    let reads = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    await page.route('**/api/v1/dashboard*', async (route: Route) => {
      if (new URL(route.request().url()).pathname !== '/api/v1/dashboard')
        return route.fallback();
      reads++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (reads === 2) await gate;
      inFlight--;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: snapshot({ done: reads >= 3, readIntervalSeconds: 2 }),
      });
    });
    await page.goto('/pull-requests.html');
    await expect.poll(() => reads).toBe(1);
    // The first answer is false with a 2 s advice; the poll's read is held.
    await page.clock.runFor(2500);
    await expect.poll(() => reads).toBe(2);
    await page.clock.runFor(15_000);
    expect(reads).toBe(2);
    expect(maxInFlight).toBe(1);

    // The next poll goes out after the held one's answer, not before.
    release();
    await expect(page.getByTestId('list-skeleton')).toBeVisible();
    await page.clock.runFor(1500);
    expect(reads).toBe(2);
    await page.clock.runFor(700);
    await expect.poll(() => reads).toBe(3);
    expect(maxInFlight).toBe(1);
  });

  test('a poll read that never answers is aborted, and the poll resumes', async ({
    page,
  }) => {
    await page.clock.install();
    let reads = 0;
    await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    await page.route('**/api/v1/dashboard*', async (route: Route) => {
      if (new URL(route.request().url()).pathname !== '/api/v1/dashboard')
        return route.fallback();
      reads++;
      // The second read hangs for good, like a half-open connection.
      if (reads === 2) return new Promise<void>(() => {});
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: snapshot({
          done: reads >= 3,
          withItems: reads >= 3,
          readIntervalSeconds: 2,
        }),
      });
    });
    await page.goto('/pull-requests.html');
    await expect.poll(() => reads).toBe(1);
    await page.clock.runFor(2500);
    await expect.poll(() => reads).toBe(2);
    await page.clock.runFor(35_000);
    await expect.poll(() => reads).toBeGreaterThanOrEqual(3);
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
  });

  test('a first read that never answers is aborted, so the page settles', async ({
    page,
  }) => {
    await page.clock.install();
    let reads = 0;
    await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    await page.route('**/api/v1/dashboard*', async (route: Route) => {
      if (new URL(route.request().url()).pathname !== '/api/v1/dashboard')
        return route.fallback();
      reads++;
      if (reads === 1) return new Promise<void>(() => {});
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: snapshot({ done: true, withItems: true }),
      });
    });
    await page.goto('/pull-requests.html');
    await expect.poll(() => reads).toBe(1);
    await expect(page.getByTestId('list-skeleton')).toBeVisible();
    await page.clock.runFor(35_000);
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    expect(reads).toBe(2);
  });

  test('a failed first request still arms the poll, so the page recovers', async ({
    page,
  }) => {
    await page.clock.install();
    let reads = 0;
    await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    await page.route('**/api/v1/dashboard*', (route: Route) => {
      if (new URL(route.request().url()).pathname !== '/api/v1/dashboard')
        return route.fallback();
      reads++;
      if (reads === 1) return route.abort();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: snapshot({ done: true, withItems: true }),
      });
    });
    await page.goto('/pull-requests.html');
    await expect.poll(() => reads).toBe(1);
    await page.clock.runFor(10_500);
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    expect(reads).toBe(2);
  });

  for (const advice of [0, -3, 1e12]) {
    test(`an advised interval of ${advice} falls back to a safe poll`, async ({
      page,
    }) => {
      await page.clock.install();
      let reads = 0;
      await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
        route.abort(),
      );
      await page.route('**/api/v1/dashboard*', (route: Route) => {
        if (new URL(route.request().url()).pathname !== '/api/v1/dashboard')
          return route.fallback();
        reads++;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: snapshot({ done: true, readIntervalSeconds: advice }),
        });
      });
      await page.goto('/pull-requests.html');
      await expect.poll(() => reads).toBe(1);
      // No tight loop, and the poll still runs: the cap is 300 s, the
      // fallback for the others the 10 s default.
      const huge = advice > 1000;
      await page.clock.runFor(huge ? 301_000 : 60_000);
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(reads).toBeLessThanOrEqual(huge ? 3 : 8);
    });
  }
});
