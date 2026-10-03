import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// The two-step confirm on Merge and Close: an explicit way out, dismissal on
// an outside click, Escape and a timeout, one armed at a time, and a guard
// against a double-click confirming.
// https://github.com/alrayyes/forge-dashboard/issues/764

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `pr-confirm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'PR Confirm User');
}

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
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
    // Higher numbers are newer, so row 0 is the highest number.
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
    ...overrides,
  };
}

function snapshot(prs: unknown[]) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: prs,
    issues: [],
  };
}

function mockDashboard(page: Page, prs: unknown[]) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(prs)),
    }),
  );
}

const rowOf = (page: Page, index: number) =>
  page.locator('#pr-rows .row').nth(index);
const mergeButton = (row: Locator) =>
  row.getByRole('button', { name: 'Merge', exact: true });
const confirmMerge = (row: Locator) =>
  row.getByRole('button', { name: 'Confirm merge?' });
const cancelButton = (row: Locator) =>
  row.getByRole('button', { name: 'Cancel' });

async function openClose(row: Locator) {
  const trigger = row.getByRole('button', { name: 'More actions' });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click();
  }
  return row.getByRole('button', { name: 'Close', exact: true });
}

// A request the test has to be able to say never happened.
async function trackRequests(page: Page) {
  const calls: string[] = [];
  for (const action of ['merge', 'close']) {
    await page.route(`**/api/pull-requests/${action}`, (route: Route) => {
      calls.push(action);
      return route.fulfill({ status: 204 });
    });
  }
  return calls;
}

test.describe('confirm step: leaving it', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('Cancel has a 44px hit area and returns the row to idle without a request', async ({
    page,
  }) => {
    const calls = await trackRequests(page);
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    const row = rowOf(page, 0);
    await mergeButton(row).click();
    const cancel = cancelButton(row);
    await expect(cancel).toBeVisible();

    // WCAG 2.5.5: the target is at least 44px tall, and wide enough.
    const box = await cancel.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);

    await cancel.click();
    await expect(mergeButton(row)).toBeVisible();
    await expect(confirmMerge(row)).toHaveCount(0);
    expect(calls).toEqual([]);
  });

  test('a click on another row’s Merge disarms the first and still arms the second on that one click', async ({
    page,
  }) => {
    const calls = await trackRequests(page);
    await mockDashboard(page, [makePR(3), makePR(2)]);
    await page.reload();

    await mergeButton(rowOf(page, 0)).click();
    await expect(confirmMerge(rowOf(page, 0))).toBeVisible();

    await mergeButton(rowOf(page, 1)).click();

    await expect(confirmMerge(rowOf(page, 1))).toBeVisible();
    await expect(confirmMerge(rowOf(page, 0))).toHaveCount(0);
    await expect(mergeButton(rowOf(page, 0))).toBeVisible();
    expect(calls).toEqual([]);
  });

  test('a click on the page background disarms', async ({ page }) => {
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    await mergeButton(rowOf(page, 0)).click();
    await expect(confirmMerge(rowOf(page, 0))).toBeVisible();

    await page.locator('h1').first().click();

    await expect(confirmMerge(rowOf(page, 0))).toHaveCount(0);
    await expect(mergeButton(rowOf(page, 0))).toBeVisible();
  });

  test('a click on another button does what that button does, and disarms', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    await mergeButton(rowOf(page, 0)).click();
    await expect(confirmMerge(rowOf(page, 0))).toBeVisible();

    const trigger = rowOf(page, 0).getByRole('button', {
      name: 'More actions',
    });
    await trigger.click();

    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(confirmMerge(rowOf(page, 0))).toHaveCount(0);
  });

  test('Escape disarms Merge and returns focus to the Merge button', async ({
    page,
  }) => {
    const calls = await trackRequests(page);
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    await mergeButton(rowOf(page, 0)).click();
    await expect(confirmMerge(rowOf(page, 0))).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(mergeButton(rowOf(page, 0))).toBeFocused();
    await expect(confirmMerge(rowOf(page, 0))).toHaveCount(0);
    expect(calls).toEqual([]);
  });

  test('Escape on an armed Close disarms it, keeps the menu and focuses Close; a second Escape closes the menu', async ({
    page,
  }) => {
    const calls = await trackRequests(page);
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    const row = rowOf(page, 0);
    await (await openClose(row)).click();
    await expect(
      row.getByRole('button', { name: 'Confirm close?' }),
    ).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(
      row.getByRole('button', { name: 'Close', exact: true }),
    ).toBeFocused();
    await expect(row.locator('.row-actions-popover')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(row.locator('.row-actions-popover')).toHaveCount(0);
    await expect(
      row.getByRole('button', { name: 'More actions' }),
    ).toBeFocused();
    expect(calls).toEqual([]);
  });

  test('Cancel on an armed Close returns focus to Close inside the open menu', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    const row = rowOf(page, 0);
    await (await openClose(row)).click();
    await cancelButton(row).click();

    await expect(
      row.getByRole('button', { name: 'Close', exact: true }),
    ).toBeFocused();
    await expect(row.locator('.row-actions-popover')).toBeVisible();
  });

  test('a click outside the open menu disarms an armed Close', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    const row = rowOf(page, 0);
    await (await openClose(row)).click();
    await page.locator('h1').first().click();

    await expect(
      row.getByRole('button', { name: 'Confirm close?' }),
    ).toHaveCount(0);
    await (await openClose(row)).waitFor();
  });
});

test.describe('confirm step: timeout', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('disarms itself after 8 seconds, with a countdown line hidden from screen readers', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    const calls = await trackRequests(page);
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    const row = rowOf(page, 0);
    await mergeButton(row).click();
    await expect(confirmMerge(row)).toBeVisible();
    const line = row.locator('.confirm-countdown');
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute('aria-hidden', 'true');

    // The pointer still sits where Merge was, which pauses the countdown.
    await page.mouse.move(2, 2);
    await page.clock.fastForward(7000);
    await expect(confirmMerge(row)).toBeVisible();

    await page.clock.fastForward(1500);
    await expect(confirmMerge(row)).toHaveCount(0);
    await expect(mergeButton(row)).toBeVisible();
    expect(calls).toEqual([]);
  });

  test('keyboard focus inside the group pauses the countdown', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    const row = rowOf(page, 0);
    await mergeButton(row).focus();
    await page.keyboard.press('Enter');
    await expect(confirmMerge(row)).toBeFocused();

    await page.clock.fastForward(30_000);
    await expect(confirmMerge(row)).toBeVisible();

    // Tabbing out of the group, to the next control, starts it again.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.clock.fastForward(8500);
    await expect(confirmMerge(row)).toHaveCount(0);
  });

  test('hover inside the group pauses the countdown, and leaving resumes it', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    const row = rowOf(page, 0);
    await mergeButton(row).click();
    await cancelButton(row).hover();

    await page.clock.fastForward(30_000);
    await expect(confirmMerge(row)).toBeVisible();

    await page.mouse.move(2, 2);
    await page.clock.fastForward(8500);
    await expect(confirmMerge(row)).toHaveCount(0);
  });

  test('a timeout releases a snapshot the armed row was holding back', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    let prs = [makePR(2)];
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(prs)),
      }),
    );
    await page.reload();

    const row = rowOf(page, 0);
    await mergeButton(row).click();
    await cancelButton(row).hover();

    // The background poll lands while the row is armed and held.
    prs = [makePR(2, { title: 'Renamed upstream' })];
    await page.clock.fastForward(31_000);
    await expect(rowOf(page, 0)).toContainText('Pull request 2');
    await expect(confirmMerge(row)).toBeVisible();

    await page.mouse.move(2, 2);
    await page.clock.fastForward(8500);
    await expect(rowOf(page, 0)).toContainText('Renamed upstream');
  });
});

test.describe('confirm step: one at a time and the double-click guard', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('arming Close in one row disarms Merge in another', async ({ page }) => {
    await mockDashboard(page, [makePR(3), makePR(2)]);
    await page.reload();

    await mergeButton(rowOf(page, 0)).click();
    await expect(confirmMerge(rowOf(page, 0))).toBeVisible();

    await (await openClose(rowOf(page, 1))).click();

    await expect(
      rowOf(page, 1).getByRole('button', { name: 'Confirm close?' }),
    ).toBeVisible();
    await expect(confirmMerge(rowOf(page, 0))).toHaveCount(0);
    await expect(mergeButton(rowOf(page, 0))).toBeVisible();
  });

  test('a double-click on Merge arms but does not merge', async ({ page }) => {
    const calls = await trackRequests(page);
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    const row = rowOf(page, 0);
    await mergeButton(row).dblclick();

    await expect(confirmMerge(row)).toBeVisible();
    await page.waitForTimeout(200);
    expect(calls).toEqual([]);
  });

  test('a double-click on Close arms but does not close', async ({ page }) => {
    const calls = await trackRequests(page);
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    const row = rowOf(page, 0);
    await (await openClose(row)).dblclick();

    await expect(
      row.getByRole('button', { name: 'Confirm close?' }),
    ).toBeVisible();
    await page.waitForTimeout(200);
    expect(calls).toEqual([]);
  });

  test('Confirm still merges once the guard has passed', async ({ page }) => {
    const calls = await trackRequests(page);
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    const row = rowOf(page, 0);
    await mergeButton(row).dblclick();
    await expect(confirmMerge(row)).toBeVisible();
    await page.waitForTimeout(700);
    await confirmMerge(row).click();

    await expect.poll(() => calls).toEqual(['merge']);
  });

  test('a repeated Enter on the focused Merge does not merge', async ({
    page,
  }) => {
    const calls = await trackRequests(page);
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    const row = rowOf(page, 0);
    await mergeButton(row).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    await expect(confirmMerge(row)).toBeVisible();
    await page.waitForTimeout(200);
    expect(calls).toEqual([]);
  });
});

test.describe('confirm step: state outside the DOM', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('an armed row survives a snapshot, and the held update lands when it disarms', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    let prs = [makePR(2)];
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(prs)),
      }),
    );
    await page.reload();

    const row = rowOf(page, 0);
    await mergeButton(row).focus();
    await page.keyboard.press('Enter');
    await expect(confirmMerge(row)).toBeFocused();

    // The background poll lands; keyboard focus keeps the countdown paused.
    prs = [makePR(2, { title: 'Renamed upstream' })];
    await page.clock.fastForward(31_000);
    await expect(rowOf(page, 0)).toContainText('Pull request 2');
    await expect(confirmMerge(row)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(rowOf(page, 0)).toContainText('Renamed upstream');
    await expect(
      page.getByRole('button', { name: 'Confirm merge?' }),
    ).toHaveCount(0);
  });

  test('an armed row survives the board being rebuilt', async ({ page }) => {
    await mockDashboard(page, [makePR(3), makePR(2)]);
    await page.reload();

    const row = page.locator('#pr-rows .row', { hasText: 'Pull request 2' });
    await mergeButton(row).focus();
    await page.keyboard.press('Enter');
    await expect(confirmMerge(row)).toBeVisible();

    // A filter that still matches rebuilds every row from scratch. Keyboard
    // only, so nothing counts as an outside click.
    await page.keyboard.press('/');
    await page.keyboard.type('Pull request 2');
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: 'Confirm merge?' }),
    ).toBeVisible();
  });

  test('the armed state is dropped when its pull request leaves the board', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR(3), makePR(2)]);
    await page.reload();

    const row = page.locator('#pr-rows .row', { hasText: 'Pull request 2' });
    await mergeButton(row).focus();
    await page.keyboard.press('Enter');
    await expect(confirmMerge(row)).toBeVisible();

    // Keyboard only, so nothing counts as an outside click.
    await page.keyboard.press('/');
    await page.keyboard.type('Pull request 3');
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);

    await page.locator('input[aria-label="Filter by title"]').fill('');
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);
    await expect(
      page.getByRole('button', { name: 'Confirm merge?' }),
    ).toHaveCount(0);
  });
});

test.describe('confirm step: screen readers', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('arming announces once, politely, and cancelling adds nothing', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR(342)]);
    await page.reload();

    const live = page.locator('#feedback-live');
    await expect(live).toHaveAttribute('aria-live', 'polite');

    const row = rowOf(page, 0);
    await mergeButton(row).click();
    await expect(live).toHaveText(
      'Confirm merge of #342? Press Confirm or Cancel.',
    );

    await cancelButton(row).click();
    await page.waitForTimeout(150);
    await expect(live).toHaveText(
      'Confirm merge of #342? Press Confirm or Cancel.',
    );
    await expect(page.locator('#feedback-toasts .feedback-toast')).toHaveCount(
      0,
    );
  });

  test('arming Close announces the close wording', async ({ page }) => {
    await mockDashboard(page, [makePR(342)]);
    await page.reload();

    await (await openClose(rowOf(page, 0))).click();
    await expect(page.locator('#feedback-live')).toHaveText(
      'Confirm close of #342? Press Confirm or Cancel.',
    );
  });

  test('an armed Merge row has no axe-core violations', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    await mergeButton(rowOf(page, 0)).click();
    await expect(confirmMerge(rowOf(page, 0))).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('an armed Close in the open menu has no axe-core violations', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockDashboard(page, [makePR(2)]);
    await page.reload();

    const row = rowOf(page, 0);
    await (await openClose(row)).click();
    await expect(
      row.getByRole('button', { name: 'Confirm close?' }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
