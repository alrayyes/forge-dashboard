import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// #1206: a row's failure line for a network failure clears itself after ten
// seconds, pauses while it is hovered or focused, and the row is read again
// from the server when it goes. A refusal that needs a person stays until it
// is dismissed.

const PR = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 42,
  title: 'A pull request',
  url: 'https://example.com/42',
  author: 'claude',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'mergeable',
  behind: true,
  kind: 'regular',
};

const snapshot = () =>
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: [PR],
    issues: [],
  });

// Counts the forced refreshes, which is how a row is read again.
async function setup(page: Page) {
  const refreshes = { count: 0 };
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard/refresh', (route: Route) => {
    refreshes.count++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    });
  });
  await page.route('**/api/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    }),
  );
  return refreshes;
}

const row = (page: Page) => page.locator('#pr-rows .row').first();
const line = (page: Page) => row(page).locator('.row-feedback-line');

async function failMerge(page: Page) {
  await row(page).getByRole('button', { name: 'Merge', exact: true }).click();
  await row(page).getByRole('button', { name: 'Confirm merge?' }).click();
  await expect(line(page)).toContainText('Failed');
}

async function failUpdateBranch(page: Page) {
  await row(page).getByRole('button', { name: 'Update branch' }).click();
  await expect(line(page)).toContainText('Failed');
}

test.describe('a network failure line clears itself (#1206)', () => {
  // Writes nothing per user, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date() });
  });

  test('a merge that never reached the server says so in plain words, then clears after ten seconds and the row is read again', async ({
    page,
  }) => {
    const refreshes = await setup(page);
    await page.route('**/api/pull-requests/merge', (route) =>
      route.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    await failMerge(page);

    await expect(line(page)).toContainText("Couldn't reach the server");
    await expect(line(page)).not.toContainText('Failed to fetch');
    const before = refreshes.count;

    await page.clock.fastForward(9_000);
    await expect(line(page)).toHaveCount(1);
    await page.clock.fastForward(1_500);
    await expect(line(page)).toHaveCount(0);
    await expect.poll(() => refreshes.count).toBeGreaterThan(before);
    await expect(
      row(page).getByRole('button', { name: 'Merge', exact: true }),
    ).toBeVisible();
  });

  test('an update that never reached the server clears the same way', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    await failUpdateBranch(page);
    await expect(line(page)).toContainText("Couldn't reach the server");

    await page.clock.fastForward(10_500);
    await expect(line(page)).toHaveCount(0);
    await expect(
      row(page).getByRole('button', { name: 'Update branch' }),
    ).toBeEnabled();
  });

  test('a forge that answered 502 is transient too', async ({ page }) => {
    await setup(page);
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'unknown', message: 'EOF' }),
      }),
    );
    await page.goto('/pull-requests.html');
    await failUpdateBranch(page);

    await page.clock.fastForward(10_500);
    await expect(line(page)).toHaveCount(0);
  });

  test('a refusal that needs a person stays until it is dismissed', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'permission',
          message: 'Missing permission',
        }),
      }),
    );
    await page.goto('/pull-requests.html');
    await failUpdateBranch(page);

    await page.clock.fastForward(120_000);
    await expect(line(page)).toHaveCount(1);
    await line(page)
      .getByRole('button', { name: /Dismiss/ })
      .click();
    await expect(line(page)).toHaveCount(0);
  });

  test('hovering the line holds the timer, and it restarts when the pointer leaves', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    await failUpdateBranch(page);

    await line(page).hover();
    await page.clock.fastForward(30_000);
    await expect(line(page)).toHaveCount(1);

    await page.mouse.move(2, 2);
    await page.clock.fastForward(9_000);
    await expect(line(page)).toHaveCount(1);
    await page.clock.fastForward(1_500);
    await expect(line(page)).toHaveCount(0);
  });

  test('focus inside the line holds the timer too', async ({ page }) => {
    await setup(page);
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    await failUpdateBranch(page);

    await line(page)
      .getByRole('button', { name: /Dismiss/ })
      .focus();
    await page.clock.fastForward(30_000);
    await expect(line(page)).toHaveCount(1);
  });

  // Only a success toast times out (six seconds); an error toast waits for
  // a person, as before. The line clearing changes neither.
  test('the error toast is unchanged when the line clears', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    await failUpdateBranch(page);
    const toast = page.locator('#feedback-toasts .feedback-toast');
    await expect(toast).toHaveCount(1);

    await page.clock.fastForward(10_500);
    await expect(line(page)).toHaveCount(0);
    await expect(toast).toHaveCount(1);
  });

  test('the failure is said once, nothing is said when it clears, and Activity keeps it', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    await failUpdateBranch(page);

    const live = page.locator('#feedback-live');
    await expect(live).toContainText("Couldn't update the branch");
    const said = await live.textContent();

    await page.clock.fastForward(10_500);
    await expect(line(page)).toHaveCount(0);
    expect(await live.textContent()).toBe(said);

    await page.locator('#activity-toggle').click();
    await expect(page.locator('.activity-list')).toContainText('Update branch');
  });

  test('has no axe-core violations with the failure line showing', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    await failUpdateBranch(page);
    await page.clock.fastForward(7_000);
    await expect(line(page)).toHaveCount(1);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
