import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #1630: what the two Settings values do to the Issues page and to Insights.
// The server removes the matching issues and says how many in
// settingsHiddenIssueCount; the pages only stop drawing the fields the
// settings replace and say how many are hidden. The server half is a separate
// pull request, so /api/dashboard is a stand-in shaped
// like api/openapi.yaml. Filter state is saved per user: the spec has its own.
// https://github.com/alrayyes/forge-dashboard/issues/1630

function issue(number: number, title: string) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://example.com/issues/${number}`,
    author: 'ryan',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

interface Stand {
  hideDependencyDashboard: boolean;
  ignoredTitles: string[];
  hidden: number | undefined;
  pullRequests: Record<string, unknown>[];
}

async function standIn(page: Page, init: Partial<Stand> = {}) {
  const stand: Stand = {
    hideDependencyDashboard: false,
    ignoredTitles: [],
    hidden: undefined,
    pullRequests: [],
    ...init,
  };
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) => {
    const issues = [issue(1, 'Fix the login page'), issue(2, 'Add dark mode')];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: stand.pullRequests,
        issues,
        openIssueCount: issues.length,
        hideDependencyDashboard: stand.hideDependencyDashboard,
        ignoredTitlesSet: stand.ignoredTitles.length > 0,
        ...(stand.hidden === undefined
          ? {}
          : { settingsHiddenIssueCount: stand.hidden }),
        repos: [],
        hiddenDrafts: 0,
      }),
    });
  });
  return stand;
}

const dependencyBox = (page: Page) =>
  page.getByRole('checkbox', { name: 'Hide Dependency Dashboard' });
const patternBox = (page: Page) =>
  page.getByRole('textbox', { name: 'Hide titles matching (regex)' });
const note = (page: Page) => page.locator('#issue-settings-note');
const rows = (page: Page) => page.locator('#issue-rows > .row');

test.describe('Issues page follows the settings (#1630)', () => {
  test('with nothing set, both fields are drawn and there is no note', async ({
    page,
  }) => {
    await standIn(page);
    await page.goto('/issues.html');
    await expect(rows(page)).toHaveCount(2);
    await expect(dependencyBox(page)).toBeVisible();
    await expect(patternBox(page)).toBeVisible();
    await expect(note(page)).toHaveCount(0);
  });

  test('reads the flags from the snapshot and asks /api/settings for nothing', async ({
    page,
  }) => {
    const asked: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/settings') asked.push(r.method());
    });
    await standIn(page, { hideDependencyDashboard: true });
    await page.goto('/issues.html');
    await expect(rows(page)).toHaveCount(2);
    await expect(dependencyBox(page)).toBeHidden();
    await page.goto('/insights.html');
    await expect(page.locator('#issue-hide-dependency-dashboard')).toBeHidden();
    expect(asked).toEqual([]);
  });

  test('a snapshot without the flags reads as nothing set', async ({
    page,
  }) => {
    await page.route('**/api/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [],
          pullRequests: [],
          issues: [issue(1, 'Fix the login page')],
          repos: [],
        }),
      }),
    );
    await page.goto('/issues.html');
    await expect(rows(page)).toHaveCount(1);
    await expect(dependencyBox(page)).toBeVisible();
    await expect(patternBox(page)).toBeVisible();
  });

  test('the Dependency Dashboard setting removes that checkbox only', async ({
    page,
  }) => {
    await standIn(page, { hideDependencyDashboard: true });
    await page.goto('/issues.html');
    await expect(rows(page)).toHaveCount(2);
    await expect(dependencyBox(page)).toBeHidden();
    await expect(patternBox(page)).toBeVisible();
  });

  test('a non-empty list removes the pattern box only', async ({ page }) => {
    await standIn(page, { ignoredTitles: ['^Weekly report'] });
    await page.goto('/issues.html');
    await expect(rows(page)).toHaveCount(2);
    await expect(patternBox(page)).toBeHidden();
    await expect(dependencyBox(page)).toBeVisible();
  });

  test('says how many the settings hide and links to Settings', async ({
    page,
  }) => {
    await standIn(page, {
      hideDependencyDashboard: true,
      ignoredTitles: ['^Weekly report'],
      hidden: 3,
    });
    await page.goto('/issues.html');
    await expect(note(page)).toContainText('3 hidden by your settings');
    await expect(
      note(page).getByRole('link', { name: 'Settings' }),
    ).toHaveAttribute('href', /\/settings(\.html)?#issue-settings$/);
  });

  test('a count of 0 draws no note', async ({ page }) => {
    await standIn(page, { hideDependencyDashboard: true, hidden: 0 });
    await page.goto('/issues.html');
    await expect(rows(page)).toHaveCount(2);
    await expect(note(page)).toHaveCount(0);
  });

  test('the page keeps its own saved values while a setting applies and gets them back', async ({
    page,
  }) => {
    const stand = await standIn(page);
    await page.goto('/issues.html');
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/settings/filter-state') &&
        r.request().method() === 'PUT',
    );
    await patternBox(page).fill('^Add');
    await saved;
    const savedAgain = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/settings/filter-state') &&
        r.request().method() === 'PUT',
    );
    await dependencyBox(page).uncheck();
    await savedAgain;

    stand.hideDependencyDashboard = true;
    stand.ignoredTitles = ['^Weekly report'];
    await page.reload();
    await expect(rows(page)).toHaveCount(2);
    await expect(dependencyBox(page)).toBeHidden();
    await expect(patternBox(page)).toBeHidden();
    // A second load of the page: same.
    await page.reload();
    await expect(patternBox(page)).toBeHidden();

    stand.hideDependencyDashboard = false;
    stand.ignoredTitles = [];
    await page.reload();
    await expect(patternBox(page)).toHaveValue('^Add');
    await expect(dependencyBox(page)).not.toBeChecked();
  });

  test('Clear filters leaves the settings alone', async ({ page }) => {
    await standIn(page, {
      hideDependencyDashboard: true,
      ignoredTitles: ['^Weekly report'],
      hidden: 2,
    });
    await page.goto('/issues.html');
    await expect(note(page)).toBeVisible();
    const title = page.locator('.col-filter[data-col="title"]').first();
    await title.fill('login');
    const clear = page.locator('#clear-filters-button');
    await expect(clear).toBeEnabled();
    await clear.click();
    await expect(title).toHaveValue('');
    await expect(dependencyBox(page)).toBeHidden();
    await expect(patternBox(page)).toBeHidden();
    await expect(note(page)).toContainText('2 hidden by your settings');
  });

  // Pins how Clear filters meets both of its rules at once: it forgets a pick
  // held from another page (#1620), and it keeps the saved values of a field
  // the settings replace (#1630). Undoing either on a merge fails this.
  test('Clear filters drops a held pick and keeps the hidden fields saved values', async ({
    page,
  }) => {
    const pr = (number: number, author: string) => ({
      forge: 'github',
      repo: 'alrayyes/app',
      number,
      title: `Pull request ${number}`,
      url: `https://example.com/pull/${number}`,
      author,
      draft: false,
      ci: 'success',
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mergeStatus: 'mergeable',
    });
    const stand = await standIn(page);
    stand.pullRequests = [pr(1, 'claude'), pr(2, 'dana')];
    const savedFilters = () =>
      page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/settings/filter-state') &&
          r.request().method() === 'PUT',
      );
    const nav = (name: string) =>
      page.locator(`.app-nav a[href="/${name}.html"]`);

    // Settings off: the page's own values, an unchecked box and a pattern.
    await page.goto('/issues.html');
    let saved = savedFilters();
    await patternBox(page).fill('^Add');
    await saved;
    saved = savedFilters();
    await dependencyBox(page).uncheck();
    await saved;

    // Settings on: hold an author pick that Issues does not offer.
    stand.hideDependencyDashboard = true;
    stand.ignoredTitles = ['^Weekly report'];
    await page.goto('/issues.html');
    await expect(rows(page)).toHaveCount(2);
    await expect(patternBox(page)).toBeHidden();
    await nav('pull-requests').click();
    const author = page.locator('#shared-author-select');
    await author.selectOption('claude');
    await nav('issues').click();
    await expect(rows(page)).toHaveCount(2);

    // Something visible to clear, then Clear filters.
    await page.locator('.col-filter[data-col="title"]').first().fill('login');
    saved = savedFilters();
    await page.locator('#clear-filters-button').click();
    await saved;

    // Settings off again: the page's values are back, the held pick is gone.
    stand.hideDependencyDashboard = false;
    stand.ignoredTitles = [];
    await page.goto('/issues.html');
    await expect(dependencyBox(page)).not.toBeChecked();
    await expect(patternBox(page)).toHaveValue('^Add');
    await nav('pull-requests').click();
    await page.waitForLoadState('networkidle');
    await expect(author).toHaveValue('');
    // What the account keeps, which another browser would read.
    const keptFilters = await (
      await page.request.get('/api/settings/filter-state')
    ).json();
    expect(keptFilters.shared.author ?? '').toBe('');
    expect(keptFilters.issue).toMatchObject({
      hideDependencyDashboard: '',
      hideTitleRegex: '^Add',
    });
  });

  test('Clear filters is off when only a hidden field differs from the default', async ({
    page,
  }) => {
    // The box is unchecked on the page, but the setting applies: nothing
    // visible differs from the default, so there is nothing to clear.
    const stand = await standIn(page);
    await page.goto('/issues.html');
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/settings/filter-state') &&
        r.request().method() === 'PUT',
    );
    await dependencyBox(page).uncheck();
    await saved;
    await expect(page.locator('#clear-filters-button')).toBeEnabled();
    stand.hideDependencyDashboard = true;
    await page.reload();
    await expect(page.locator('#clear-filters-button')).toBeDisabled();
  });

  test('fits a 360px phone with the note, no sideways scroll', async ({
    page,
  }) => {
    await standIn(page, { ignoredTitles: ['^Weekly report'], hidden: 12 });
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/issues.html');
    await expect(note(page)).toBeVisible();
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe with the note and a field removed, ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await standIn(page, {
        hideDependencyDashboard: true,
        ignoredTitles: ['^Weekly report'],
        hidden: 4,
      });
      await page.goto('/issues.html');
      await expect(note(page)).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

test.describe('Insights follows the settings (#1630)', () => {
  test('draws its Dependency Dashboard checkbox with the setting off', async ({
    page,
  }) => {
    await standIn(page);
    await page.goto('/insights.html');
    await expect(
      page.locator('#issue-hide-dependency-dashboard'),
    ).toBeVisible();
    await expect(note(page)).toHaveCount(0);
  });

  test('does not draw it with the setting on, and says how many are hidden', async ({
    page,
  }) => {
    await standIn(page, { hideDependencyDashboard: true, hidden: 5 });
    await page.goto('/insights.html');
    await expect(note(page)).toContainText('5 hidden by your settings');
    await expect(page.locator('#issue-hide-dependency-dashboard')).toBeHidden();
    await page.reload();
    await expect(page.locator('#issue-hide-dependency-dashboard')).toBeHidden();
  });

  test('a list alone leaves the checkbox, and the note still shows', async ({
    page,
  }) => {
    await standIn(page, { ignoredTitles: ['^Weekly report'], hidden: 1 });
    await page.goto('/insights.html');
    await expect(note(page)).toContainText('1 hidden by your settings');
    await expect(
      page.locator('#issue-hide-dependency-dashboard'),
    ).toBeVisible();
  });
});
