import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

// #791: draft pull requests are left out by the API unless asked for. The
// filter bar carries a quiet "Show drafts" toggle with a muted count of what
// is hidden; the choice persists like the other filters and rides on the
// dashboard fetch, the refresh POST and the live stream.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `drafts-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Drafts Test User');
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

function makePR(number: number, draft: boolean): MockPR {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `${draft ? 'Draft' : 'Ready'} change ${number}`,
    url: `https://example.com/${number}`,
    author: 'claude',
    draft,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'blocked',
    behind: false,
  };
}

const READY = [1, 2, 3, 4, 5].map((n) => makePR(n, false));
const DRAFTS = [6, 7, 8].map((n) => makePR(n, true));

// The API's own rule: drafts are absent and counted unless includeDrafts.
function answer(route: Route) {
  const include =
    new URL(route.request().url()).searchParams.get('includeDrafts') === 'true';
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
      pullRequests: include ? [...READY, ...DRAFTS] : READY,
      issues: [],
      repos: [],
      hiddenDrafts: include ? 0 : DRAFTS.length,
    }),
  });
}

async function setup(page: Page) {
  const seen: string[] = [];
  await page.addInitScript(() => {
    const w = window as unknown as {
      __streamUrls: string[];
      EventSource: typeof EventSource;
    };
    w.__streamUrls = [];
    const Real = w.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        w.__streamUrls.push(String(url));
      }
    };
  });
  await page.route('**/api/dashboard*', (route: Route) => {
    seen.push(route.request().url());
    return answer(route);
  });
  await page.route('**/api/dashboard/refresh*', (route: Route) => {
    seen.push(`POST ${route.request().url()}`);
    return answer(route);
  });
  await page.reload();
  return seen;
}

const toggle = (page: Page) =>
  page.getByRole('button', { name: /^Show drafts/ });
const rows = (page: Page) => page.locator('#pr-rows .row');

test.describe('show drafts (#791)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('drafts are left out by default, with a muted hidden count on an off toggle', async ({
    page,
  }) => {
    const seen = await setup(page);

    await expect(rows(page)).toHaveCount(5);
    await expect(page.locator('#pr-rows .draft-badge')).toHaveCount(0);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle(page)).toContainText('3 hidden');
    expect(seen.some((u) => u.includes('includeDrafts'))).toBe(false);
  });

  test('turning it on shows the drafts, marked, and drops the count', async ({
    page,
  }) => {
    const seen = await setup(page);
    await toggle(page).click();

    await expect(rows(page)).toHaveCount(8);
    await expect(page.locator('#pr-rows .draft-badge')).toHaveCount(3);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle(page)).not.toContainText('hidden');
    expect(seen.some((u) => u.includes('includeDrafts=true'))).toBe(true);
  });

  test('the choice survives a reload and goes on every fetch, refresh and the stream', async ({
    page,
  }) => {
    await setup(page);
    await toggle(page).click();
    await expect(rows(page)).toHaveCount(8);

    const seen: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/dashboard')) seen.push(r.url());
    });
    await page.reload();
    await expect(rows(page)).toHaveCount(8);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) expect(url, url).toContain('includeDrafts=true');

    await page.locator('#force-refresh-button').click();
    await expect
      .poll(() => seen.filter((u) => u.includes('/refresh')).length)
      .toBeGreaterThan(0);
    for (const url of seen) expect(url, url).toContain('includeDrafts=true');

    const streams = await page.evaluate(
      () => (window as unknown as { __streamUrls: string[] }).__streamUrls,
    );
    expect(streams.length).toBeGreaterThan(0);
    for (const url of streams) expect(url).toContain('includeDrafts=true');
  });

  test('turning it off again reopens the stream without drafts', async ({
    page,
  }) => {
    await setup(page);
    await toggle(page).click();
    await expect(rows(page)).toHaveCount(8);
    await toggle(page).click();

    await expect(rows(page)).toHaveCount(5);
    await expect(toggle(page)).toContainText('3 hidden');
    const streams = await page.evaluate(
      () => (window as unknown as { __streamUrls: string[] }).__streamUrls,
    );
    expect(streams.at(-1)).not.toContain('includeDrafts');
  });

  test('the toggle has no axe-core violations, on or off', async ({ page }) => {
    await setup(page);
    for (const _ of [0, 1]) {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
      await toggle(page).click();
    }
  });
});
