import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import {
  actionsFooter,
  closeActionsDialog,
  openActionsDialog,
} from './actions-dialog-helper';
import { test } from './server-fixture';

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
  allowedActions?: { action: string; primary?: boolean }[];
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
    // The live stream isn't part of these tests. Aborted, so no real stream
    // stays open against the server, and
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

  // A refused Close locks its button, but the button lives in the dialog. The
  // row says so itself, in words, so nobody opens every dialog to find out.
  test('a refused Close still says so on the row after the dialog is closed', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', (route: Route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: 403 Resource not accessible by integration',
          code: 'permission',
          message: "This token can't close pull requests on this repository.",
        }),
      }),
    );
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const { dialog, footer, close } = await openCloseInDialog(row);
    // Nothing locked, nothing said, before any refusal.
    await expect(row.locator('.row-lock-cue')).toHaveCount(0);
    await close.click();
    await footer
      .getByRole('button', { name: 'Confirm close pull request?' })
      .click();
    await expect(
      footer.getByRole('button', { name: 'Close pull request', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');
    await closeActionsDialog(dialog);

    const cue = row.locator('.row-lock-cue');
    await expect(cue).toBeVisible();
    await expect(cue).toHaveText(/^Close locked/);
    // The reason is read with the cue, not only hovered.
    await expect(cue).toContainText('Missing permission');
    // One cue, and no second Close control on the row.
    await expect(page.locator('#pr-rows .row .row-lock-cue')).toHaveCount(1);
    await expect(
      row.getByRole('button', { name: 'Close pull request', exact: true }),
    ).toHaveCount(0);
  });

  test('dismissing the failure line lifts the Close lock and its cue', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', (route: Route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: 403 Resource not accessible by integration',
          code: 'permission',
          message: "This token can't close pull requests on this repository.",
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
    await closeActionsDialog(dialog);
    await expect(row.locator('.row-lock-cue')).toBeVisible();

    await row.getByRole('button', { name: /^Dismiss failure/ }).click();
    await expect(row.locator('.row-lock-cue')).toHaveCount(0);
    const reopened = await openCloseInDialog(row);
    await expect(reopened.close).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('the Close lock cue (rate limited) is words, passes axe, and holds at a phone width', async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
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
      await page.goto('/pull-requests.html');
      const row = page.locator('#pr-rows .row').first();
      const { dialog, footer, close } = await openCloseInDialog(row);
      await close.click();
      await footer
        .getByRole('button', { name: 'Confirm close pull request?' })
        .click();
      await closeActionsDialog(dialog);
      const cue = row.locator('.row-lock-cue');
      await expect(cue).toBeVisible();

      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(cue).toBeVisible();
        const box = await cue.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThan(0);
        const scroll = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(scroll).toBeLessThanOrEqual(0);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      }
    }
  });

  test('the permission Close lock cue says why and passes axe, light and dark', async ({
    page,
  }) => {
    await page.route('**/api/pull-requests/close', (route: Route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: 403 Resource not accessible by integration',
          code: 'permission',
          message: "This token can't close pull requests on this repository.",
        }),
      }),
    );
    await mockDashboard(page, makePR());
    await page.goto('/pull-requests.html');
    const row = page.locator('#pr-rows .row').first();
    const { dialog, footer, close } = await openCloseInDialog(row);
    await close.click();
    await footer
      .getByRole('button', { name: 'Confirm close pull request?' })
      .click();
    await closeActionsDialog(dialog);
    const cue = row.locator('.row-lock-cue');
    await expect(cue).toContainText('Missing permission');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(cue).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    }
  });

  test('a Close that succeeded or was never tried has no lock cue', async ({
    page,
  }) => {
    const pr = makePR();
    let closed = false;
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: closed ? [] : [pr],
          issues: [],
        }),
      }),
    );
    await page.route('**/api/pull-requests/close', (route: Route) => {
      closed = true;
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
    await expect(row.getByRole('button', { name: /^#\d+ / })).toBeVisible();
    // Never tried.
    await expect(row.locator('.row-lock-cue')).toHaveCount(0);

    // Tried and succeeded: the row is gone, and no cue is left anywhere.
    const { dialog, footer, close } = await openCloseInDialog(row);
    await close.click();
    await footer
      .getByRole('button', { name: 'Confirm close pull request?' })
      .click();
    await closeActionsDialog(dialog);
    await expect(page.locator('#pr-rows .row')).toHaveCount(0);
    await expect(page.locator('.row-lock-cue')).toHaveCount(0);
  });

  test('when Close is the row action itself, a lock shows on that one control, with no second cue', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({
        mergeStatus: 'mergeable',
        empty: true,
        allowedActions: [{ action: 'close', primary: true }],
      }),
    );
    await page.route('**/api/pull-requests/close', (route: Route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: 403 Resource not accessible by integration',
          code: 'permission',
          message: "This token can't close pull requests on this repository.",
        }),
      }),
    );
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    const rowClose = row.getByRole('button', {
      name: 'Close pull request',
      exact: true,
    });
    await rowClose.click();
    await row
      .getByRole('button', { name: 'Confirm close pull request?' })
      .click();
    await expect(rowClose).toHaveAttribute('aria-disabled', 'true');
    await expect(rowClose).toHaveCount(1);
    await expect(row.locator('.row-lock-cue')).toHaveCount(0);
  });

  test('a long unbroken reason wraps inside the cue at a phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/close', (route: Route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'close refused',
          code: 'blocked_by_protection',
          message: `Refused by ${'x'.repeat(200)}`,
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
    await closeActionsDialog(dialog);
    const cue = row.locator('.row-lock-cue');
    await expect(cue).toContainText('xxxxxxxxxx');
    const scroll = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(scroll).toBeLessThanOrEqual(0);
    // The text wraps inside the cue instead of spilling out of it: its own
    // box stays within the cue's and within the screen.
    const cueBox = await cue.boundingBox();
    const reasonBox = await cue.locator('.row-action-note-next').boundingBox();
    expect(reasonBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((reasonBox?.x ?? 0) + (reasonBox?.width ?? 0)).toBeLessThanOrEqual(
      (cueBox?.x ?? 0) + (cueBox?.width ?? 0) + 1,
    );
    expect((reasonBox?.x ?? 0) + (reasonBox?.width ?? 0)).toBeLessThanOrEqual(
      390,
    );
  });
});
