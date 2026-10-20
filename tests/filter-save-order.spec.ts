import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { toggleLabels } from './label-filter-helper';
import { registerViaInvite } from './register-helper';

// #1637: two picks made one after the other each send a PUT. The server keeps
// whichever lands last, so if the first is slow the older snapshot used to
// overwrite the newer one. The first PUT is held back here to force that
// order. The saved state is per user, so this spec registers its own.
// https://github.com/alrayyes/forge-dashboard/issues/1637

const ISSUES = [
  {
    forge: 'github',
    repo: 'acme/app',
    number: 1,
    title: 'Issue 1',
    url: 'https://example.com/issues/1',
    author: 'ryan',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/issues.html');
}

test('a pick made right after another is the one the server keeps (#1637)', async ({
  page,
  request,
  baseURL,
}) => {
  await registerViaInvite(
    page,
    request,
    baseURL,
    `filter-save-order-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    'Filter Save Order',
  );
  await open(page);
  await expect(page.locator('#issue-rows > .row')).toHaveCount(1);

  let puts = 0;
  let landed = 0;
  page.on('requestfinished', (req) => {
    if (
      req.method() === 'PUT' &&
      req.url().includes('/api/settings/filter-state')
    )
      landed++;
  });
  await page.route('**/api/settings/filter-state', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    puts++;
    // The first save is slow, so an unordered client lets the second overtake it.
    if (puts === 1) await new Promise((r) => setTimeout(r, 600));
    return route.continue();
  });

  await page.locator('#shared-author-select').selectOption('ryan');
  await toggleLabels(page, 'bug');
  await expect.poll(() => puts, { timeout: 5000 }).toBeGreaterThan(0);

  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/settings/filter-state');
        const body = await res.json();
        return `${body.shared?.author ?? ''}/${body.shared?.label ?? ''}`;
      },
      { timeout: 5000 },
    )
    .toBe('ryan/bug');
  // Wait for the slow request to have landed too: the answer must not revert.
  await expect.poll(() => landed, { timeout: 5000 }).toBe(puts);
  const res = await page.request.get('/api/settings/filter-state');
  const body = await res.json();
  expect(body.shared).toMatchObject({ author: 'ryan', label: 'bug' });
});
