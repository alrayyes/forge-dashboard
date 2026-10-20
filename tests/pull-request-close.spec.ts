import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import {
  actionsFooter,
  closeActionsDialog,
  openActionsDialog,
} from './actions-dialog-helper';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// Every test mocks /api/dashboard and writes nothing per user, so they start
// from the shared session instead of registering a user each (#1379).
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

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

// Close is in the row's dialog footer, with the Hide items. Opens the dialog
// and returns its footer and Close button.
async function openCloseInDialog(row: Locator) {
  const dialog = await openActionsDialog(row);
  const footer = actionsFooter(dialog);
  return {
    dialog,
    footer,
    close: footer.getByRole('button', {
      name: 'Close pull request',
      exact: true,
    }),
  };
}

test.describe('pull request close button', () => {
  test.beforeEach(async ({ page }) => {
    // The live stream isn't part of these tests. Aborted, so a shared user's
    // concurrent pages never hold a real stream open against the server, and
    // a real snapshot can't be pushed over the mock.
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
  });

  // mergeStatus: 'blocked' throughout — Close is offered regardless of
  // mergeability (a PR that can't be merged is often exactly the one that
  // needs closing), but only in the pop-up: never as a standalone row
  // button.
  test('Close is not a standalone row button, even when the pull request cannot be merged', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    // Wait for the row first: absent proves nothing before it has rendered.
    await expect(row.getByRole('button', { name: /^#\d+ / })).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Close pull request', exact: true }),
    ).toHaveCount(0);
  });

  test('a pull request that cannot be merged still offers Close in its dialog', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const { close } = await openCloseInDialog(row);
    await expect(close).toBeVisible();
  });

  // #1223: no green nudge any more. Close is the same neutral button on an
  // empty pull request as everywhere else; Merge is locked beside it.
  test('an empty pull request gets no special colour on Close', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', empty: true }),
    );
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const { close } = await openCloseInDialog(row);
    await expect(close).not.toHaveClass(/suggested/);
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
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const { footer, close } = await openCloseInDialog(row);
    await close.click();

    await expect(
      footer.getByRole('button', { name: 'Confirm close pull request?' }),
    ).toBeVisible();
    await expect(footer.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(closeCalled).toBe(false);
  });

  test('clicking Close moves keyboard focus to the new Confirm close button', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const { footer, close } = await openCloseInDialog(row);
    await close.click();

    await expect(
      footer.getByRole('button', { name: 'Confirm close pull request?' }),
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
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const { footer, close } = await openCloseInDialog(row);
    await close.click();
    await footer.getByRole('button', { name: 'Cancel' }).click();

    await expect(
      footer.getByRole('button', {
        name: 'Close pull request',
        exact: true,
      }),
    ).toBeVisible();
    expect(closeCalled).toBe(false);
  });

  test('confirm close has no axe-core violations inside the open dialog', async ({
    page,
  }) => {
    // The confirm button fades in; scanning mid-fade measures a blended
    // colour, not the real one.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockDashboard(page, makePR());
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const { footer, close } = await openCloseInDialog(row);
    await close.click();
    await expect(
      footer.getByRole('button', { name: 'Confirm close pull request?' }),
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
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const { dialog, footer, close } = await openCloseInDialog(row);
    await close.click();
    await footer
      .getByRole('button', { name: 'Confirm close pull request?' })
      .click();
    // The modal covers the row, so close it before asserting the row left.
    await closeActionsDialog(dialog);

    await expect(page.locator('#pr-rows .row')).toHaveCount(0);
    expect(requestBody).toEqual({
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 42,
    });
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
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const { footer, close } = await openCloseInDialog(row);
    await close.click();
    await footer
      .getByRole('button', { name: 'Confirm close pull request?' })
      .click();

    await expect(row.locator('.wait-chip-label')).toHaveText('Closing');
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
          message: 'pull request already merged',
        }),
      }),
    );
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const { footer, close } = await openCloseInDialog(row);
    await close.click();
    await footer
      .getByRole('button', { name: 'Confirm close pull request?' })
      .click();

    await expect(page.locator('#feedback-toasts')).toContainText(
      'pull request already merged',
    );
    await expect(row.locator('.row-feedback')).toContainText(
      'pull request already merged',
    );
    await expect(page.locator('#error-banner')).toHaveCount(0);
    await expect(close).toBeVisible();
    await expect(close).toBeEnabled();
  });
});
