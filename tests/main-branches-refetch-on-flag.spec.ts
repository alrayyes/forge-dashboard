import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// The Branches page reads its list once and then every 60 seconds, so a first
// refresh that finishes in between must make it read again at once.
// https://github.com/alrayyes/forge-dashboard/issues/1729

function row(fullName: string) {
  return {
    forge: 'github',
    fullName,
    url: `https://example.com/${fullName}`,
    branch: 'main',
    status: 'passed',
    commit: {
      sha: 'd98f3c2',
      subject: `fix: change in ${fullName}`,
      author: 'sre-dev',
      committedAt: new Date().toISOString(),
    },
    failingJobs: [],
    finishedAt: new Date().toISOString(),
    durationSeconds: 60,
    runUrl: `https://example.com/${fullName}/actions/runs/1`,
    staleSince: null,
  };
}

function list(names: string[]) {
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      failed: 0,
      running: 0,
      none: 0,
      passed: names.length,
      total: names.length,
    },
    branches: names.map(row),
  };
}

type Server = {
  done: boolean;
  branches: string[];
  failNext: boolean;
  branchRequests: number;
};

// /api/dashboard answers the flag from `server.done`; /api/main-branches
// answers `server.branches` and counts its requests. The layout asks again
// every 3 s while the flag is false, so a flip shows up without a reload.
async function serve(page: Page, server: Server) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        readIntervalSeconds: 1,
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
        firstRefreshDone: server.done,
        navCounts: navCountsFor([], 0),
      }),
    }),
  );
  await page.route('**/api/main-branches', (route: Route) => {
    server.branchRequests++;
    if (server.failNext) {
      server.failNext = false;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"boom"}',
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(list(server.branches)),
    });
  });
}

const rows = (page: Page) => page.locator('[data-testid="main-branch-row"]');
const empty = (page: Page) => page.locator('[data-testid="no-repos"]');

// The layout re-reads the flag when the tab is shown again, which spares the
// test the 30 s poll once the flag is true.
const askForFlag = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test.describe('Branches refetches when the first refresh finishes (#1729)', () => {
  test('shows the rows as soon as the flag turns true, without waiting for the poll', async ({
    page,
  }) => {
    const server: Server = {
      done: false,
      branches: [],
      failNext: false,
      branchRequests: 0,
    };
    await serve(page, server);
    await page.goto('/');
    await expect(page.locator('.list-region[aria-busy="true"]')).toBeVisible();
    await expect(empty(page)).toHaveCount(0);

    server.branches = ['acme/one', 'acme/two'];
    server.done = true;

    await expect(rows(page)).toHaveCount(2);
    await expect(empty(page)).toHaveCount(0);
    expect(server.branchRequests).toBe(2);
  });

  test('a flag that is already true on load adds no extra request', async ({
    page,
  }) => {
    const server: Server = {
      done: true,
      branches: ['acme/one'],
      failNext: false,
      branchRequests: 0,
    };
    await serve(page, server);
    const settled = page.waitForResponse('**/api/dashboard');
    await page.goto('/');
    await settled;
    await expect(rows(page)).toHaveCount(1);
    await askForFlag(page);
    await page.waitForResponse('**/api/dashboard');
    expect(server.branchRequests).toBe(1);
  });

  test('each flip refetches once, a second restart included', async ({
    page,
  }) => {
    const server: Server = {
      done: false,
      branches: [],
      failNext: false,
      branchRequests: 0,
    };
    await serve(page, server);
    await page.goto('/');
    await expect(page.locator('.list-region[aria-busy="true"]')).toBeVisible();
    await expect.poll(() => server.branchRequests).toBe(1);
    server.branches = ['acme/one'];
    server.done = true;
    await expect(rows(page)).toHaveCount(1);
    expect(server.branchRequests).toBe(2);

    server.done = false;
    await askForFlag(page);
    await expect(page.locator('.list-region[aria-busy="true"]')).toBeVisible();
    server.branches = ['acme/one', 'acme/two'];
    server.done = true;
    await expect(rows(page)).toHaveCount(2);
    expect(server.branchRequests).toBe(3);
  });

  test('a failed refetch keeps the previous rows', async ({ page }) => {
    const server: Server = {
      done: true,
      branches: ['acme/one'],
      failNext: false,
      branchRequests: 0,
    };
    await serve(page, server);
    await page.goto('/');
    await expect(rows(page)).toHaveCount(1);

    server.done = false;
    await askForFlag(page);
    await expect(page.locator('.list-region[aria-busy="true"]')).toBeVisible();
    server.failNext = true;
    server.done = true;
    await expect.poll(() => server.branchRequests).toBe(2);
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
