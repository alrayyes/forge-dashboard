import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import {
  actionsFooter,
  closeActionsDialog,
  openActionsDialog,
  viaActionsDialog,
} from './actions-dialog-helper';
import { test } from './server-fixture';

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

// The click that fails the action leaves the pointer where the line is then
// drawn. Chrome sends a synthetic mouseenter for that once layout settles,
// and the line holds its timer while hovered (WCAG 2.2.1), so a late enter
// pauses the ten seconds for good. Move the pointer off the row and wait for
// the line to report it is no longer hovered, so the timer is running.
async function releasePointer(page: Page) {
  await page.mouse.move(2, 2);
  await expect
    .poll(() => line(page).evaluate((el) => el.matches(':hover')))
    .toBe(false);
}

async function failMerge(page: Page) {
  await row(page).getByRole('button', { name: 'Merge', exact: true }).click();
  await row(page).getByRole('button', { name: 'Confirm merge?' }).click();
  await expect(line(page)).toContainText('Failed');
  await releasePointer(page);
}

async function failUpdateBranch(page: Page) {
  // Update branch isn't the row's primary action here, so it is clicked in
  // the pop-up's footer; the failure line is drawn on the row as well.
  await viaActionsDialog(row(page), async (footer) => {
    await footer.getByRole('button', { name: 'Update branch' }).click();
  });
  await expect(line(page)).toContainText('Failed');
  await releasePointer(page);
}

test.describe('a network failure line clears itself (#1206)', () => {
  test.beforeEach(async ({ page }) => {
    // Paused, so only fastForward moves time. A running clock lets the ten
    // seconds pass in real time on a loaded host, before the assertion looks.
    const now = Date.now();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now + 1000);
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
      actionsFooter(await openActionsDialog(row(page))).getByRole('button', {
        name: 'Update branch',
      }),
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

    // The action is clicked in the pop-up, and the announcement is spoken
    // 30 ms later through whichever live region is current then: the pop-up's
    // while it is open, the page's once it has closed. Closing the pop-up
    // races that timer, so wait for the words in the pop-up's own region
    // before closing it, rather than hoping the page's region got them.
    const dialog = await openActionsDialog(row(page));
    await actionsFooter(dialog)
      .getByRole('button', { name: 'Update branch' })
      .click();
    // The clock is paused, so run the 30 ms announcement timer by hand.
    await page.clock.runFor(100);
    await expect(
      dialog.locator('[role="status"][aria-live="polite"][aria-atomic="true"]'),
    ).toContainText("Couldn't update the branch");
    await closeActionsDialog(dialog);
    await expect(line(page)).toContainText('Failed');
    await releasePointer(page);

    const live = page.locator('#feedback-live');
    const said = await live.textContent();

    await page.clock.fastForward(10_500);
    await expect(line(page)).toHaveCount(0);
    // An announcement is spoken 30 ms after it is made, so run that timer
    // too, or a sentence added when the line clears would not be heard yet.
    await page.clock.fastForward(100);
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

    // axe-core schedules its own timers, so it needs a running clock. Focus
    // inside the line holds its clear timer (WCAG 2.2.1), so resuming the
    // clock cannot clear the line under the scan.
    await line(page)
      .getByRole('button', { name: /Dismiss/ })
      .focus();
    await page.clock.resume();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
