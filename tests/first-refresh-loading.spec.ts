import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { navCountsFor } from './nav-counts-helper';
import { registerViaInvite } from './register-helper';

// #1672: until the server says this viewer's first refresh has finished
// (`firstRefreshDone`, contract #1673), the list pages draw a skeleton, not
// their empty states, and the nav pills show a dash, not 0.
// https://github.com/alrayyes/forge-dashboard/issues/1672

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `first-refresh-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'First Refresh');
}

function makePR(number: number, kind = 'regular') {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pulls/${number}`,
    author: 'claude',
    kind,
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: false,
  };
}

function makeIssue(number: number) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: 'alrayyes',
    labels: [],
    createdAt: new Date(Date.now() - number * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
  };
}

type Mode = { done: boolean | undefined; withItems: boolean };

// Answers /api/dashboard from `mode`, which a test flips to release the first
// refresh. The poll interval is one second so the page picks the flip up.
async function holdDashboard(page: Page, mode: Mode) {
  await page.route('**/api/dashboard/stream', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) => {
    const prs = mode.withItems
      ? [makePR(1), makePR(2, 'release'), makePR(3, 'dependency')]
      : [];
    const issues = mode.withItems ? [makeIssue(1), makeIssue(2)] : [];
    const snapshot: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      readIntervalSeconds: 1,
      forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
      pullRequests: prs,
      issues,
      repos: [],
      hiddenDrafts: 0,
      navCounts: navCountsFor(prs, issues.length),
    };
    if (mode.done !== undefined) snapshot.firstRefreshDone = mode.done;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot),
    });
  });
}

const navPills = (page: Page) =>
  page.getByRole('navigation', { name: 'Main' }).locator('.nav-total');

// page, URL, the empty-state text it must not show while loading, and the
// row selector it shows once loaded with items.
const LISTS = [
  {
    name: 'Pull requests',
    url: '/pull-requests.html',
    empty: '#pr-empty',
    noResults: '#pr-no-results',
    rows: '#pr-rows .row',
    emptyText: /No open pull requests/,
  },
  {
    name: 'Releases',
    url: '/releases.html',
    empty: '#pr-empty',
    noResults: '#pr-no-results',
    rows: '#pr-rows .row',
    emptyText: /No release pull requests are open/,
  },
  {
    name: 'Bots',
    url: '/bots.html',
    empty: '#pr-empty',
    noResults: '#pr-no-results',
    rows: '#pr-rows .row',
    emptyText: /No bot pull requests are open/,
  },
  {
    name: 'Issues',
    url: '/issues.html',
    empty: '#issue-empty',
    noResults: '#issue-no-results',
    rows: '#issue-rows > .row',
    emptyText: /No open issues/,
  },
];

test.describe('first refresh loading state (#1672)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  for (const list of LISTS) {
    test(`${list.name} shows a skeleton while loading, then the real empty state`, async ({
      page,
    }) => {
      const mode: Mode = { done: false, withItems: false };
      await holdDashboard(page, mode);
      await page.goto(list.url);

      const region = page.locator('.list-region');
      await expect(region).toHaveAttribute('aria-busy', 'true');
      await expect(region.getByTestId('list-skeleton')).toBeVisible();
      await expect(page.getByTestId('first-refresh-status')).toHaveText(
        'Loading your repositories…',
      );
      // Neither empty text is drawn, nor the filtered-out one.
      await expect(page.locator(list.empty)).toBeHidden();
      await expect(page.locator(list.noResults)).toBeHidden();
      await expect(page.getByText(list.emptyText)).toBeHidden();
      // The nav pills are a placeholder, never a 0.
      const pills = navPills(page);
      expect(await pills.count()).toBeGreaterThan(0);
      for (const text of await pills.allTextContents())
        expect(text.trim()).toBe('–');

      // Focus stays where it was when the first refresh finishes.
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link')
        .first()
        .focus();
      const focused = await page.evaluate(() =>
        document.activeElement?.getAttribute('href'),
      );

      mode.done = true;
      await expect(page.locator(list.empty)).toBeVisible();
      await expect(page.getByText(list.emptyText)).toBeVisible();
      await expect(region).not.toHaveAttribute('aria-busy', /.*/);
      await expect(region.getByTestId('list-skeleton')).toHaveCount(0);
      await expect(page.getByTestId('first-refresh-status')).toHaveText('');
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute('href')),
      ).toBe(focused);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('rows replace the skeleton when the first refresh finishes with items', async ({
    page,
  }) => {
    const mode: Mode = { done: false, withItems: true };
    await holdDashboard(page, mode);
    await page.goto('/pull-requests.html');

    await expect(page.getByTestId('list-skeleton')).toBeVisible();
    await expect(page.locator('#pr-rows .row')).toBeHidden();

    mode.done = true;
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    await expect(page.getByTestId('list-skeleton')).toHaveCount(0);
    await expect(navPills(page).first()).not.toHaveText('–');
  });

  test('a snapshot without the flag counts as loaded', async ({ page }) => {
    const mode: Mode = { done: undefined, withItems: false };
    await holdDashboard(page, mode);
    await page.goto('/pull-requests.html');

    await expect(page.locator('#pr-empty')).toBeVisible();
    await expect(page.getByTestId('list-skeleton')).toHaveCount(0);
    await expect(page.locator('.list-region')).not.toHaveAttribute(
      'aria-busy',
      /.*/,
    );
  });

  test('the Branches page shows the skeleton too, and the nav a dash', async ({
    page,
  }) => {
    const mode: Mode = { done: false, withItems: false };
    await holdDashboard(page, mode);
    await page.goto('/');

    await expect(page.locator('.list-region')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(page.getByTestId('list-skeleton')).toBeVisible();
    await expect(page.getByTestId('no-repos')).toBeHidden();

    mode.done = true;
    await expect(page.getByTestId('no-repos')).toBeVisible();
    await expect(page.getByTestId('list-skeleton')).toHaveCount(0);
  });

  test('after about ten seconds the status line says it can take a while', async ({
    page,
  }) => {
    await page.clock.install();
    const mode: Mode = { done: false, withItems: false };
    await holdDashboard(page, mode);
    await page.goto('/pull-requests.html');

    const status = page.getByTestId('first-refresh-status');
    await expect(status).toHaveText('Loading your repositories…');
    await page.clock.fastForward(11_000);
    await expect(status).toHaveText(
      'Still loading. The first refresh can take a while after a restart.',
    );
  });

  test('nothing animates under prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await holdDashboard(page, { done: false, withItems: false });
    await page.goto('/pull-requests.html');

    const bar = page.locator('.skeleton-bar').first();
    await expect(bar).toBeVisible();
    expect(await bar.evaluate((el) => getComputedStyle(el).animationName)).toBe(
      'none',
    );
  });

  test('the skeleton shimmers when motion is fine', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await holdDashboard(page, { done: false, withItems: false });
    await page.goto('/pull-requests.html');

    const bar = page.locator('.skeleton-bar').first();
    expect(await bar.evaluate((el) => getComputedStyle(el).animationName)).toBe(
      'skeleton-shimmer',
    );
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`at 360px in the ${scheme} scheme the loading state does not scroll sideways and passes axe`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 360, height: 740 });
      await page.emulateMedia({ colorScheme: scheme });
      await holdDashboard(page, { done: false, withItems: false });
      await page.goto('/pull-requests.html');

      await expect(page.getByTestId('list-skeleton')).toBeVisible();
      await expect(page.getByTestId('first-refresh-status')).toHaveText(
        'Loading your repositories…',
      );
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
});
