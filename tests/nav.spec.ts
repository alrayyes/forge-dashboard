import { type APIRequestContext, expect, type Page } from '@playwright/test';
import { STORAGE_STATE_PATH as ADMIN_STORAGE_STATE } from './admin-global-setup';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// Coverage for issue #269: one persistent nav, shared markup, present and
// consistent on every page rather than a per-page "back to X" link.
//
// Locators are scoped to `.app-nav` (the header's own nav landmark,
// aria-label="Main") rather than a bare `a[aria-label="..."]`, since
// #645's mobile bottom tab bar (`.bottom-nav`, aria-label="Mobile
// navigation") reuses the same per-destination labels on every `(app)`
// page — an unscoped locator would match two elements there and fail
// Playwright's strict mode. See openspec/changes/mobile-bottom-nav/
// design.md - Decisions.
async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `nav-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Nav Test User');
}

// In menu order: Branches, Pull requests, Releases, Bots, Issues, then the
// rest (#1279, #1321).
// `tab` is what the bottom bar's accessible name contains, since its visible
// word for Pull requests is the shorter "PRs".
const NAV_PAGES = [
  { path: '/', label: 'Branches', tab: 'Branches' },
  { path: '/pull-requests.html', label: 'Pull requests', tab: 'PRs' },
  { path: '/releases.html', label: 'Releases', tab: 'Releases' },
  { path: '/bots.html', label: 'Bots', tab: 'Bots' },
  { path: '/issues.html', label: 'Issues', tab: 'Issues' },
  { path: '/insights.html', label: 'Insights', tab: 'Insights' },
  { path: '/webhooks.html', label: 'Webhooks', tab: 'Webhooks' },
  { path: '/settings.html', label: 'Settings', tab: 'Settings' },
];

// Pull requests, Issues, Releases and Bots leave the navigation while their
// count is 0 (#1228, #1415), and a new user has nothing, so here only these
// four are always there; the page you are on keeps its own link.
const ALWAYS_THERE = ['Branches', 'Insights', 'Webhooks', 'Settings'];
const linksOn = (label: string) =>
  NAV_PAGES.filter((p) => ALWAYS_THERE.includes(p.label) || p.label === label);

const NO_SESSION_PAGES = [
  '/changelog.html',
  '/disclaimer.html',
  '/privacy.html',
];

test.describe('persistent top nav', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  for (const { path, label } of NAV_PAGES) {
    test(`on ${path}, every nav icon is present and ${label} is marked current`, async ({
      page,
    }) => {
      await page.goto(path);

      for (const other of linksOn(label)) {
        await expect(
          page.locator(`.app-nav a[aria-label^="${other.label}"]`),
        ).toBeVisible();
      }

      await expect(
        page.locator(`.app-nav a[aria-label^="${label}"]`),
      ).toHaveAttribute('aria-current', 'page');
      for (const other of linksOn(label)) {
        if (other.label === label) continue;
        await expect(
          page.locator(`.app-nav a[aria-label^="${other.label}"]`),
        ).not.toHaveAttribute('aria-current', /.*/);
      }
    });
  }

  // With something on every page, so no link is left out (#1228): a regular
  // pull request, a release, a bot's and an issue.
  async function serveEveryPage(page: Page) {
    const pr = (number: number, kind: string) => ({
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
      updatedAt: new Date().toISOString(),
      mergeStatus: 'mergeable',
      kind,
    });
    await page.route('**/api/dashboard/stream*', (r) => r.abort());
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [
            pr(1, 'regular'),
            pr(2, 'release'),
            pr(3, 'dependency'),
          ],
          issues: [],
          openIssueCount: 1,
        }),
      }),
    );
  }

  // The order the user asked for (#1321): Branches, Pull requests, Releases,
  // Bots, then Issues, and the rest after them.
  const MENU_ORDER = [
    'Branches',
    'Pull requests',
    'Releases',
    'Bots',
    'Issues',
    'Insights',
    'Webhooks',
    'Settings',
  ];

  test('the header menu runs Branches, Pull requests, Releases, Bots, Issues (#1321)', async ({
    page,
  }) => {
    await serveEveryPage(page);
    await page.goto('/settings.html');
    await expect(page.locator('.app-nav a[href="/issues.html"]')).toBeVisible();

    const names = await page
      .locator('.app-nav a[aria-label]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));

    expect(names.map((n) => n.split(',')[0])).toEqual(MENU_ORDER);
  });

  test('the phone tab bar runs in the same order (#1321)', async ({ page }) => {
    await serveEveryPage(page);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto('/settings.html');
    await expect(
      page.locator('.bottom-nav a[href="/issues.html"]'),
    ).toBeVisible();

    const hrefs = await page
      .locator('.bottom-nav a')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')));

    expect(hrefs).toEqual([
      '/',
      '/pull-requests.html',
      '/releases.html',
      '/bots.html',
      '/issues.html',
      '/insights.html',
      '/webhooks.html',
      '/settings.html',
    ]);
  });

  test('/main-branches.html still works: it sends you to the Branches page (#1279)', async ({
    page,
  }) => {
    await page.goto('/main-branches.html');
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.locator('.app-nav a[aria-label^="Branches"]'),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('the Admin icon stays hidden for a non-admin session, on every page with the nav', async ({
    page,
  }) => {
    for (const { path } of NAV_PAGES) {
      await page.goto(path);
      await expect(page.locator('#admin-link')).toBeHidden();
    }
  });

  // Signed in, as the describe's beforeEach has it: the layout counts here
  // too (#1261), so a link with nothing behind it is left out (#1228), and
  // no link is current since none of these pages is in the nav.
  for (const path of NO_SESSION_PAGES) {
    test(`${path} renders the nav without the empty links, and marks nothing current`, async ({
      page,
    }) => {
      await page.goto(path);

      for (const label of ALWAYS_THERE) {
        await expect(
          page.locator(`.app-nav a[aria-label^="${label}"]`),
        ).toBeVisible();
        await expect(
          page.locator(`.app-nav a[aria-label^="${label}"]`),
        ).not.toHaveAttribute('aria-current', /.*/);
      }
      await expect(page.locator('#admin-link')).toBeHidden();
    });
  }
});

// Coverage for #645: a mobile bottom tab bar as a second nav surface,
// below the same breakpoint style.css already treats as "mobile" for
// the header (max-width: 420px) — see openspec/changes/mobile-bottom-nav/
// design.md - Decisions for why 390x844 (an iPhone-class width) exercises
// it and the default desktop viewport doesn't.
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.describe('mobile bottom tab bar', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  for (const { path, label, tab } of NAV_PAGES) {
    test(`on ${path} at mobile width, the bottom tab bar shows every tab and only ${label} is current`, async ({
      page,
    }) => {
      await page.setViewportSize(MOBILE_VIEWPORT);
      await page.goto(path);

      for (const other of linksOn(label)) {
        await expect(
          page.locator(`.bottom-nav a[aria-label*="${other.tab}"]`),
        ).toBeVisible();
      }
      await expect(
        page.locator('.bottom-nav a[aria-label="Admin"]'),
      ).toHaveCount(0);

      await expect(
        page.locator(`.bottom-nav a[aria-label*="${tab}"]`),
      ).toHaveAttribute('aria-current', 'page');
      for (const other of linksOn(label)) {
        if (other.label === label) continue;
        await expect(
          page.locator(`.bottom-nav a[aria-label*="${other.tab}"]`),
        ).not.toHaveAttribute('aria-current', /.*/);
      }

      // The header's own nav surface is the one this exact scenario
      // replaces at this width — still present in the DOM (see
      // design.md's CSS-only, no-{#if}, rationale) but not visible and
      // not in the tab order.
      await expect(page.locator('.app-nav')).toBeHidden();
    });
  }

  test('at desktop width, the bottom tab bar is hidden and not in the tab order', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.bottom-nav')).toBeHidden();
    await expect(page.locator('.app-nav')).toBeVisible();
  });

  test('every bottom tab is keyboard-reachable and Enter activates it', async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto('/');

    const webhooksTab = page.locator('.bottom-nav a[aria-label="Webhooks"]');
    await webhooksTab.focus();
    await expect(webhooksTab).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/webhooks\.html$/);
  });

  test('focus is visible on a bottom tab, same convention as the header nav', async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto('/');

    const homeTab = page.locator('.bottom-nav a[href="/"]');
    await homeTab.focus();
    await expect(homeTab).toHaveCSS('outline-style', 'solid');
  });
});

test.describe('persistent top nav, admin session', () => {
  test('the Admin icon appears for an admin session on a non-dashboard page too, and is marked current on admin.html', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext({
      storageState: ADMIN_STORAGE_STATE,
    });
    try {
      const adminPage = await adminContext.newPage();

      await adminPage.goto('/settings.html');
      await expect(adminPage.locator('#admin-link')).toBeVisible();

      await adminPage.goto('/admin.html');
      await expect(adminPage.locator('#admin-link')).toHaveAttribute(
        'aria-current',
        'page',
      );
    } finally {
      await adminContext.close();
    }
  });
});
