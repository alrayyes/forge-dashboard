import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// Filter the pull requests list by whether a pull request closes an issue, and
// the issues list by whether a pull request closes the issue. A segment like
// Auto-merge: one pick of Any, yes or no, saved with the other filters.
// https://github.com/alrayyes/forge-dashboard/issues/2275

const LINK = { repo: 'acme/app', number: 1, url: 'https://example.com/i/1' };

function pr(number: number, title: string, closes: boolean, kind = 'regular') {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
    kind,
    ...(closes
      ? { closesIssues: [{ ...LINK, pageUrl: '/issues.html?issue=x' }] }
      : {}),
  };
}

function issue(number: number, title: string, linked: boolean) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title,
    url: `https://example.com/issues/${number}`,
    author: 'alrayyes',
    labels: [],
    createdAt: new Date(Date.now() - number * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    ...(linked
      ? {
          linkedPullRequests: [
            {
              forge: 'github',
              repo: 'acme/app',
              number: 9,
              draft: false,
              pageUrl: '/pull-requests.html',
              ci: 'success',
              checks: { passed: 1, running: 0, waiting: 0, failed: 0 },
              awaitingWorkflowApproval: false,
            },
          ],
        }
      : {}),
  };
}

const PRS = [
  pr(1, 'Fixes a bug', true),
  pr(2, 'Closes two things', true),
  pr(3, 'Standalone change', false),
];
const ISSUES = [
  issue(11, 'Has a fix coming', true),
  issue(12, 'Nobody on it', false),
  issue(13, 'Also nobody', false),
];

let prs: unknown[] = PRS;
let issues: unknown[] = ISSUES;

async function open(page: Page, path: string) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: prs,
        issues,
        openIssueCount: issues.length,
        repos: [],
        hiddenDrafts: 0,
        navCounts: navCountsFor(prs as never, issues.length),
      }),
    }),
  );
  await page.goto(path);
}

const bar = (page: Page) => page.locator('.filter-bar > .link-group');
const choice = (page: Page, value: 'any' | 'yes' | 'no') =>
  bar(page).locator(`[data-link="${value}"]`);
const prTitles = (page: Page) => page.locator('#pr-rows > .row .title-text');
const issueTitles = (page: Page) =>
  page.locator('#issue-rows > .row .title-text');

async function pick(page: Page, value: 'any' | 'yes' | 'no') {
  // The buttons are in the markup before the script wires them; rows mean it ran.
  await expect(page.locator('.row').first()).toBeVisible();
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v1/settings/filter-state') &&
      r.request().method() !== 'GET',
  );
  await choice(page, value).click();
  await saved;
}

test.beforeEach(() => {
  prs = PRS;
  issues = ISSUES;
});

test.describe('Pull requests: closes an issue', () => {
  test('Closes an issue and Closes no issue split the list', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html');
    await expect(prTitles(page)).toHaveCount(3);

    await choice(page, 'yes').click();
    await expect(prTitles(page)).toHaveCount(2);
    await expect(page.locator('#pr-rows')).not.toContainText('Standalone');
    await expect(choice(page, 'yes')).toHaveAttribute('aria-pressed', 'true');

    await choice(page, 'no').click();
    await expect(prTitles(page)).toHaveCount(1);
    await expect(prTitles(page).first()).toContainText('Standalone');

    await choice(page, 'any').click();
    await expect(prTitles(page)).toHaveCount(3);
  });

  test('the pick survives a reload and Clear filters resets it', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html');
    await pick(page, 'no');
    await page.reload();
    await expect(choice(page, 'no')).toHaveAttribute('aria-pressed', 'true');
    await expect(prTitles(page)).toHaveCount(1);

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(choice(page, 'any')).toHaveAttribute('aria-pressed', 'true');
    await expect(prTitles(page)).toHaveCount(3);
  });

  test('a choice nothing matches is not offered, and the segment goes when neither is', async ({
    page,
  }) => {
    prs = [pr(1, 'Only closing', true)];
    await open(page, '/pull-requests.html');
    await expect(choice(page, 'yes')).toBeVisible();
    await expect(choice(page, 'no')).toBeHidden();

    prs = [pr(1, 'Plain', false)];
    await page.reload();
    await expect(choice(page, 'no')).toBeVisible();
    await expect(choice(page, 'yes')).toBeHidden();
    await expect(bar(page)).toBeVisible();

    prs = [];
    await page.reload();
    await expect(bar(page)).toBeHidden();
  });

  test('a pick made here still shows, and clears, on the Bots page', async ({
    page,
  }) => {
    prs = [
      pr(1, 'Fixes a bug', true),
      pr(2, 'Bump a from 1 to 2', false, 'dependency'),
    ];
    await open(page, '/pull-requests.html');
    await pick(page, 'yes');

    await page.goto('/bots.html');
    await expect(choice(page, 'yes')).toHaveAttribute('aria-pressed', 'true');
    await expect(prTitles(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(choice(page, 'any')).toHaveAttribute('aria-pressed', 'true');
    await expect(prTitles(page)).toHaveCount(1);
  });

  test('on a 360px phone it is in the Filters sheet with 44px choices', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page, '/pull-requests.html');
    await expect(bar(page)).toBeHidden();

    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.locator('dialog#filter-sheet .link-group');
    for (const value of ['any', 'yes', 'no']) {
      const box = await sheet.locator(`[data-link="${value}"]`).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    await sheet.locator('[data-link="no"]').click();
    await page.keyboard.press('Escape');
    await expect(prTitles(page)).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: 'Remove filter: Closes no issue' }),
    ).toBeVisible();
  });
});

test.describe('Issues: has a closing pull request', () => {
  test('the two choices split the list', async ({ page }) => {
    await open(page, '/issues.html');
    await expect(issueTitles(page)).toHaveCount(3);

    await choice(page, 'yes').click();
    await expect(issueTitles(page)).toHaveCount(1);
    await expect(issueTitles(page).first()).toContainText('Has a fix');

    await choice(page, 'no').click();
    await expect(issueTitles(page)).toHaveCount(2);
    await expect(page.locator('#issue-rows')).not.toContainText('Has a fix');
  });

  test('the pick survives a reload, stays offered when nothing matches, and Clear filters resets it', async ({
    page,
  }) => {
    await open(page, '/issues.html');
    await pick(page, 'yes');
    issues = [issue(12, 'Nobody on it', false)];
    await page.reload();
    await expect(choice(page, 'yes')).toHaveAttribute('aria-pressed', 'true');
    await expect(issueTitles(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(choice(page, 'any')).toHaveAttribute('aria-pressed', 'true');
    await expect(issueTitles(page)).toHaveCount(1);
  });

  test('the two pages keep their own pick', async ({ page }) => {
    await open(page, '/issues.html');
    await pick(page, 'yes');
    await page.goto('/pull-requests.html');
    await expect(choice(page, 'any')).toHaveAttribute('aria-pressed', 'true');
    await expect(prTitles(page)).toHaveCount(3);
  });

  test('on a 360px phone it is in the Filters sheet with 44px choices', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page, '/issues.html');
    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.locator('dialog#filter-sheet .link-group');
    for (const value of ['any', 'yes', 'no']) {
      const box = await sheet.locator(`[data-link="${value}"]`).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await sheet.locator('[data-link="yes"]').click();
    await page.keyboard.press('Escape');
    await expect(issueTitles(page)).toHaveCount(1);
    await expect(
      page.getByRole('button', {
        name: 'Remove filter: Has a closing pull request',
      }),
    ).toBeVisible();
  });
});

for (const scheme of ['light', 'dark'] as const) {
  for (const path of ['/pull-requests.html', '/issues.html']) {
    test(`${path} has no axe violations in the ${scheme} theme with the pick active`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, path);
      // The buttons are in the markup before the script wires them.
      await expect(page.locator('.row').first()).toBeVisible();
      await choice(page, 'yes').click();
      await expect(choice(page, 'yes')).toHaveAttribute('aria-pressed', 'true');
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
