import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';
import { rateLimit } from './severity-stand-in';

// The forge health live region speaks when the health state changes, not on
// every snapshot (WCAG 4.1.3, status messages). The visible pill is redrawn on
// every poll, so the live region is its own element whose text only changes
// when the announcement does.

const LIVE = '#forge-health-live, #forge-health[aria-live]';

type Forge = Record<string, unknown>;
const up = (extra: Forge = {}) => ({
  forge: 'github',
  reachable: true,
  repoCount: 1,
  ...extra,
});
const down = () => ({
  forge: 'github',
  reachable: false,
  repoCount: 1,
  errorKind: 'unreachable',
  error: 'dial tcp: i/o timeout',
  staleSince: new Date(Date.now() - 5 * 60_000).toISOString(),
});

type State = { forge: Forge; requests: number; answered?: number };

async function open(page: Page, state: State) {
  await page.clock.install();
  state.answered = 0;
  page.on('requestfinished', (req) => {
    if (new URL(req.url()).pathname === '/api/dashboard')
      state.answered = (state.answered ?? 0) + 1;
  });
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) => {
    state.requests++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [state.forge],
        pullRequests: [],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    });
  });
  await page.goto('/pull-requests.html');
  await expect(page.locator(LIVE)).toContainText(/reachable/i);
  await page.evaluate((selector) => {
    const w = window as unknown as { __healthMutations: number };
    w.__healthMutations = 0;
    const region = document.querySelector(selector);
    if (!region) throw new Error('no health live region');
    new MutationObserver((list) => {
      w.__healthMutations += list.length;
    }).observe(region, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
    });
  }, LIVE);
}

// A round trip through a real (unfaked) macrotask: whatever the page queued
// before it, such as handling a response, has run once this resolves.
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = () => resolve();
        port2.postMessage(0);
      }),
  );

// Moves the page clock until the next poll has been sent, then lets the answer
// be drawn. The poll is armed when the previous answer lands, in real time, so
// the clock moves in small steps.
async function poll(page: Page, state: State) {
  const before = state.requests;
  for (let i = 0; i < 60 && state.requests === before; i++) {
    await page.clock.runFor(1000);
    await settle(page);
  }
  expect(state.requests).toBeGreaterThan(before);
  // The answer has been delivered once its request has finished.
  await expect.poll(() => state.answered).toBeGreaterThanOrEqual(before + 1);
  await settle(page);
  await settle(page);
}

const mutations = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __healthMutations: number }).__healthMutations,
  );

test.describe('the forge health live region (WCAG 4.1.3)', () => {
  test('is in the document with a polite role before any text', async ({
    page,
  }) => {
    await page.route('**/api/dashboard*', (route: Route) => route.abort());
    await page.goto('/pull-requests.html');
    const region = page.locator(LIVE);
    await expect(region).toHaveCount(1);
    await expect(region).toHaveAttribute('aria-live', 'polite');
  });

  test('an unchanged healthy forge writes nothing across several polls', async ({
    page,
  }) => {
    const state = { forge: up(), requests: 0 };
    await open(page, state);
    for (let i = 0; i < 4; i++) await poll(page, state);
    expect(await mutations(page)).toBe(0);
    await expect(page.locator(LIVE)).toContainText('GitHub reachable');
  });

  test('the visible pill keeps its content', async ({ page }) => {
    const state = { forge: up(), requests: 0 };
    await open(page, state);
    await poll(page, state);
    await expect(page.locator('#forge-health .forge-health')).toContainText(
      'GitHub reachable',
    );
  });

  test('going unreachable announces once, and recovery once', async ({
    page,
  }) => {
    const state = { forge: up(), requests: 0 };
    await open(page, state);

    state.forge = down();
    await poll(page, state);
    await expect(page.locator(LIVE)).toContainText('GitHub unreachable');
    const afterDown = await mutations(page);
    expect(afterDown).toBeGreaterThan(0);
    await poll(page, state);
    await poll(page, state);
    expect(await mutations(page)).toBe(afterDown);

    state.forge = up();
    await poll(page, state);
    await expect(page.locator(LIVE)).toContainText('GitHub reachable');
    const afterUp = await mutations(page);
    expect(afterUp).toBeGreaterThan(afterDown);
    await poll(page, state);
    expect(await mutations(page)).toBe(afterUp);
  });

  test('a changed rate-limit state announces once; a changing count does not', async ({
    page,
  }) => {
    const inMinutes = (m: number) =>
      new Date(Date.now() + m * 60_000).toISOString();
    const state = {
      forge: up({ rateLimitREST: rateLimit(5000, 4800, inMinutes(40)) }),
      requests: 0,
    };
    await open(page, state);

    // The remaining count moves every poll; the state does not.
    state.forge = up({ rateLimitREST: rateLimit(5000, 4700, inMinutes(40)) });
    await poll(page, state);
    state.forge = up({ rateLimitREST: rateLimit(5000, 4600, inMinutes(40)) });
    await poll(page, state);
    expect(await mutations(page)).toBe(0);

    state.forge = up({ rateLimitREST: rateLimit(5000, 0, inMinutes(40)) });
    await poll(page, state);
    await expect(page.locator(LIVE)).toContainText(/rate limited/i);
    const spent = await mutations(page);
    expect(spent).toBeGreaterThan(0);
    await poll(page, state);
    expect(await mutations(page)).toBe(spent);

    state.forge = up({ rateLimitREST: rateLimit(5000, 4900, inMinutes(40)) });
    await poll(page, state);
    await expect(page.locator(LIVE)).not.toContainText(/rate limited/i);
    expect(await mutations(page)).toBeGreaterThan(spent);
  });

  test('a budget running low announces once, and again only when spent', async ({
    page,
  }) => {
    const reset = new Date(Date.now() + 40 * 60_000).toISOString();
    const at = (remaining: number) =>
      up({ rateLimitREST: rateLimit(5000, remaining, reset) });
    const state = { forge: at(4000), requests: 0 };
    await open(page, state);

    state.forge = at(200);
    await poll(page, state);
    await expect(page.locator(LIVE)).toContainText(/rate limit low/i);
    await expect(page.locator(LIVE)).not.toContainText(/rate limited/i);
    const low = await mutations(page);
    expect(low).toBeGreaterThan(0);

    // The count falls, the state holds: nothing is said again.
    state.forge = at(190);
    await poll(page, state);
    state.forge = at(180);
    await poll(page, state);
    expect(await mutations(page)).toBe(low);

    state.forge = at(0);
    await poll(page, state);
    await expect(page.locator(LIVE)).toContainText(/rate limited/i);
    expect(await mutations(page)).toBeGreaterThan(low);
  });

  // #1812: the share left is spoken in coarse bands, so it reaches a
  // screen reader without being read out on every poll.
  test('a low budget speaks its band, and again only when the band changes', async ({
    page,
  }) => {
    const reset = new Date(Date.now() + 40 * 60_000).toISOString();
    const at = (remaining: number) =>
      up({ rateLimitREST: rateLimit(5000, remaining, reset) });
    const state = { forge: at(4000), requests: 0 };
    await open(page, state);

    state.forge = at(200);
    await poll(page, state);
    await expect(page.locator(LIVE)).toContainText(/rate limit low.*under 5%/i);
    const first = await mutations(page);

    state.forge = at(150);
    await poll(page, state);
    state.forge = at(110);
    await poll(page, state);
    expect(await mutations(page)).toBe(first);

    state.forge = at(60);
    await poll(page, state);
    await expect(page.locator(LIVE)).toContainText(/under 2%/i);
    expect(await mutations(page)).toBeGreaterThan(first);
  });
});
