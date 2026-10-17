import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { rateLimit } from './severity-stand-in';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The forge health live region speaks when the health state changes, not on
// every snapshot (WCAG 4.1.3, status messages). The visible pill is redrawn on
// every poll, so the live region is its own element whose text only changes
// when the announcement does.

test.use({ storageState: SHARED_STORAGE_STATE_PATH });

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

async function open(page: Page, state: { forge: Forge; requests: number }) {
  await page.clock.install();
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

// Moves the page clock until the next poll has been sent, then lets the answer
// be drawn. The poll is armed when the previous answer lands, in real time, so
// the clock moves in small steps.
async function poll(page: Page, state: { requests: number }) {
  const before = state.requests;
  for (let i = 0; i < 60 && state.requests === before; i++) {
    await page.clock.runFor(1000);
    await page.waitForTimeout(25);
  }
  expect(state.requests).toBeGreaterThan(before);
  await page.waitForTimeout(150);
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
});
