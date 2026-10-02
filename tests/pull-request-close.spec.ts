import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `pr-close-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'PR Close Test User',
  );
}

interface MockLabel {
  name: string;
  color: string;
}

interface MockPR {
  empty?: boolean;
  forge: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  ci: string;
  labels: MockLabel[];
  createdAt: string;
  updatedAt: string;
  mergeStatus: string;
}

function makePR(overrides: Partial<MockPR> = {}): MockPR {
  return {
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
    mergeStatus: 'blocked',
    ...overrides,
  };
}

function mockDashboard(page: Page, pr?: MockPR) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: pr ? [pr] : [],
        issues: [],
      }),
    }),
  );
}

// #705: Close lives in the row's "More actions" menu, so every path to it
// opens that first. A menu that's already open (a confirm step in flight)
// is left alone.
async function openClose(row: Locator) {
  const trigger = row.getByRole('button', { name: 'More actions' });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click();
  }
  return row.getByRole('button', { name: 'Close', exact: true });
}

// Holds requestAnimationFrame callbacks queued after holdFrames() until
// releaseFrames(), the way a loaded CI runner delays them. The menu moves
// focus into its popover from one of these, so a held frame is how a test
// makes "focus() landed first, the frame fires later" deterministic (#770).
async function controlFrames(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __hold: boolean;
      __held: FrameRequestCallback[];
    };
    w.__hold = false;
    w.__held = [];
    const native = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      if (!w.__hold) return native(cb);
      w.__held.push(cb);
      return 0;
    };
  });
}

async function holdFrames(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __hold: boolean }).__hold = true;
  });
}

async function releaseFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __hold: boolean;
      __held: FrameRequestCallback[];
    };
    w.__hold = false;
    for (const cb of w.__held.splice(0)) cb(performance.now());
  });
}

test.describe('pull request close button', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  // mergeStatus: 'blocked' throughout — Close is offered regardless of
  // mergeability (a PR that can't be merged is often exactly the one that
  // needs closing), but since #705 only from "More actions": never as a
  // standalone row button, and never while the menu is shut.
  test('Close is not a standalone row button, even when the pull request cannot be merged', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'Close', exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByRole('button', { name: 'More actions' }),
    ).toBeVisible();
  });

  test('a pull request that cannot be merged still offers Close in More actions', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(await openClose(row)).toBeVisible();
    await expect(
      row.locator('.row-actions-popover').getByRole('button', {
        name: 'Close',
        exact: true,
      }),
    ).toBeVisible();
  });

  // #543's own Merge stays visible-and-locked for an empty pull request
  // (see pull-request-merge.spec.ts) rather than disappearing -- Close
  // gets the visual nudge instead, so there's still one clear "do this"
  // action on the row instead of a locked Merge and a Close that reads
  // exactly like every other row's.
  test('an empty pull request nudges toward Close instead of Merge', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', empty: true }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(await openClose(row)).toHaveClass(/suggested/);
  });

  test('clicking Close arms a confirm step instead of closing immediately', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    let closeCalled = false;
    await page.route('**/api/pull-requests/close', (route: Route) => {
      closeCalled = true;
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();

    await expect(
      row.getByRole('button', { name: 'Confirm close?' }),
    ).toBeVisible();
    await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(closeCalled).toBe(false);
  });

  test('clicking Close moves keyboard focus to the new Confirm close button', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();

    await expect(
      row.getByRole('button', { name: 'Confirm close?' }),
    ).toBeFocused();
  });

  test('Cancel returns to the plain Close button without calling the API', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    let closeCalled = false;
    await page.route('**/api/pull-requests/close', (route: Route) => {
      closeCalled = true;
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();
    await row.getByRole('button', { name: 'Cancel' }).click();

    await expect(row.getByRole('button', { name: 'Close' })).toBeVisible();
    expect(closeCalled).toBe(false);
  });

  // #705: the confirm step now lives inside the menu's popover, so the
  // menu has to survive the re-render that swaps Close for it, and Escape
  // has to behave like it does everywhere else in the menu.
  test('the menu stays open while Close is being confirmed', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();

    const popover = row.locator('.row-actions-popover');
    await expect(popover).toBeVisible();
    await expect(
      popover.getByRole('button', { name: 'Confirm close?' }),
    ).toBeFocused();
    await expect(
      row.getByRole('button', { name: 'More actions' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  test('Escape closes the menu, returns focus to the trigger and drops the pending confirm', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    let closeCalled = false;
    await page.route('**/api/pull-requests/close', (route: Route) => {
      closeCalled = true;
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();
    await expect(
      row.getByRole('button', { name: 'Confirm close?' }),
    ).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(row.locator('.row-actions-popover')).toHaveCount(0);
    await expect(
      row.getByRole('button', { name: 'More actions' }),
    ).toBeFocused();
    expect(closeCalled).toBe(false);

    // Reopening finds a plain Close, not a confirm that was left armed.
    await row.getByRole('button', { name: 'More actions' }).click();
    await expect(
      row.getByRole('button', { name: 'Confirm close?' }),
    ).toHaveCount(0);
    await expect(
      row.getByRole('button', { name: 'Close', exact: true }),
    ).toBeVisible();
  });

  test('confirm close has no axe-core violations inside the open menu', async ({
    page,
  }) => {
    // The confirm button fades in; scanning mid-fade measures a blended
    // colour, not the real one.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockDashboard(page, makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();
    await expect(
      row.getByRole('button', { name: 'Confirm close?' }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('confirming calls the close API with forge/fullName/number and refreshes the board', async ({
    page,
  }) => {
    const pr = makePR();
    await mockDashboard(page, pr);
    let requestBody: unknown;
    await page.route('**/api/pull-requests/close', (route: Route) => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues: [],
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    await expect(page.locator('#pr-rows .row')).toHaveCount(0);
    expect(requestBody).toEqual({
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 42,
    });
  });

  test('confirming closes the menu so the refreshed board is not held back, and focus returns to the trigger', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    await expect(row.locator('.row-actions-popover')).toHaveCount(0);
    await expect(
      row.getByRole('button', { name: 'More actions' }),
    ).toBeFocused();
    await expect(row.locator('.row-feedback')).toContainText('Closing…');
  });

  test('shows an in-progress status while closing, then a success status', async ({
    page,
  }) => {
    const pr = makePR();
    await mockDashboard(page, pr);
    await page.route('**/api/pull-requests/close', async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues: [],
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    await expect(row.locator('.row-feedback')).toContainText('Closing…');
    const toast = page.locator('#feedback-toasts .feedback-toast').first();
    await expect(toast).toContainText('alrayyes/forge-dashboard#42');
    await expect(toast).toContainText('Closed.');
    await expect(page.locator('#status-banner')).toHaveCount(0);
  });

  // Regression coverage for #501's own fix: the forge's real rejection
  // reason (not a bare status code) must reach this error banner.
  test("a rejected close shows the forge's own reason, and returns to a re-clickable Close button", async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', (route: Route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PATCH .../pulls/42: pull request already merged',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    await expect(page.locator('#feedback-toasts')).toContainText(
      'pull request already merged',
    );
    await expect(row.locator('.row-feedback')).toContainText(
      'pull request already merged',
    );
    await expect(page.locator('#error-banner')).toHaveCount(0);
    const button = await openClose(row);
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });

  test('a permission-denied failure locks the button with no Retry and points to Settings', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', (route: Route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PATCH .../pulls/42: Forbidden',
          code: 'permission',
          message: 'Missing permission — check your token in Settings.',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    // Confirming closes the menu; the lock is found by reopening it.
    const button = await openClose(row);
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(button).toHaveAccessibleDescription(/token in Settings/);
  });

  test('a rate-limited (429) failure locks the button with no Retry and says when it resets', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', (route: Route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: rate limit exceeded',
          code: 'rate_limited',
          message:
            "The forge's API rate limit is reached. Try again once it resets.",
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    // Confirming closes the menu; the lock is found by reopening it.
    const button = await openClose(row);
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(button).toHaveAccessibleDescription(/rate limit reached/i);
  });

  // #770: opening the menu queues a frame that moves focus to the first
  // item. On a slow runner it fired after the user (or a test) had already
  // focused another item, and pulled focus off it.
  test('a delayed menu-open frame does not pull focus off the item the user reached', async ({
    page,
  }) => {
    await controlFrames(page);
    await mockDashboard(page, makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await holdFrames(page);
    const close = await openClose(row);
    await close.focus();
    await expect(close).toBeFocused();
    await releaseFrames(page);

    await expect(close).toBeFocused();
  });

  test('a delayed menu-open frame does not pull focus off a locked Close', async ({
    page,
  }) => {
    await controlFrames(page);
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', (route: Route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: rate limit exceeded',
          code: 'rate_limited',
          message:
            "The forge's API rate limit is reached. Try again once it resets.",
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    await holdFrames(page);
    const button = await openClose(row);
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await button.focus();
    await releaseFrames(page);

    await expect(button).toBeFocused();
  });

  test('a locked Close button is reachable by keyboard and has no axe-core violations', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', (route: Route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: rate limit exceeded',
          code: 'rate_limited',
          message:
            "The forge's API rate limit is reached. Try again once it resets.",
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await (await openClose(row)).click();
    await row.getByRole('button', { name: 'Confirm close?' }).click();

    // Confirming closes the menu; the lock is found by reopening it.
    const button = await openClose(row);
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await button.focus();
    await expect(button).toBeFocused();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
