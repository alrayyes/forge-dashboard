import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './fixtures';
import { rateLimit } from './severity-stand-in';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The tests mock /api/dashboard and write nothing per user, so they start from
// the shared session instead of registering a user each (#1379).
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

interface MockPR {
  forge: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  ci: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  mergeStatus: string;
  [key: string]: unknown;
}

interface MockForge {
  forge: string;
  reachable: boolean;
  repoCount: number;
  rateLimitREST?: {
    limit: number;
    remaining: number;
    resetsAt: string;
    severity: string;
  };
}

function makePR(overrides?: Partial<MockPR>): MockPR {
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
    mergeStatus: 'mergeable',
    ...overrides,
  };
}

function mockDashboard(page: Page, pr?: MockPR) {
  return page.route('**/api/dashboard*', (route) =>
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

// mockDashboardCustom, unlike mockDashboard above, takes its own forges
// array and a real list of pull requests — for the proactive-lock tests,
// which need to control ForgeHealth directly and (for the forge-wide
// permission-lock test) more than one row.
function mockDashboardCustom(page: Page, forges: MockForge[], prs: MockPR[]) {
  return page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges,
        pullRequests: prs,
        issues: [],
      }),
    }),
  );
}

const mergeButton = (row: Locator) =>
  row.getByRole('button', { name: 'Merge', exact: true });

test.describe('pull request merge button', () => {
  test.beforeEach(async ({ page }) => {
    // The live stream isn't part of these tests. Aborted, so a shared user's
    // concurrent pages never hold a real stream open against the server.
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
    await page.goto('/pull-requests.html');
  });

  test('a mergeable pull request shows a Merge button', async ({ page }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'mergeable' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
  });

  // #705: a Merge that can't be clicked yet stays on the row, locked,
  // with its reason — the full state matrix is in
  // pull-request-merge-states.spec.ts.
  test('a conflicting pull request shows a locked Merge button, not a clickable one', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'conflicting' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    const button = row.getByRole('button', { name: 'Merge' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription(/merge conflict/i);
  });

  test('a blocked pull request shows a locked Merge button, not a clickable one', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'blocked' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    const button = row.getByRole('button', { name: 'Merge' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription(/blocked/i);
  });

  // #385: GitHub's own mergeStateStatus reports CLEAN (mapped to
  // "mergeable" here) whenever branch protection doesn't mark a given
  // check as required, even while that check is still running — so a
  // PR with CI still pending could show a fully clickable Merge button
  // despite its own checks not having finished.
  test('a mergeable pull request whose CI is still running shows a locked Merge button', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', ci: 'pending' }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    const button = row.getByRole('button', { name: 'Merge' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription(
      /waiting for ci to finish/i,
    );
  });

  test('the Merge button unlocks once CI resolves, without a page reload', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', ci: 'pending' }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await page.route('**/api/dashboard/refresh', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [makePR({ mergeStatus: 'mergeable', ci: 'success' })],
          issues: [],
        }),
      }),
    );
    await page.click('#force-refresh-button');

    const unlocked = row.getByRole('button', { name: 'Merge' });
    await expect(unlocked).toBeEnabled();
    await expect(unlocked).not.toHaveAttribute('aria-disabled', 'true');
    await expect(row).not.toContainText(/waiting for ci/i);
  });

  test('a mergeable pull request whose CI already succeeded still shows a Merge button', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', ci: 'success' }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
  });

  test('a mergeable pull request whose CI failed still shows a Merge button — unchanged, deliberately out of scope for #385', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', ci: 'failure' }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
  });

  // #543: a mergeable pull request whose diff against its base is already
  // empty (content landed some other way) used to show a fully clickable Merge
  // button that quietly did nothing. #1375: nothing can unlock it, so it has
  // no Merge at all, only Close, and the status area says why.
  test('an empty pull request has no Merge, and says why in its status area', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', empty: true }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.locator('.status-area')).toContainText('Nothing to merge');
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveCount(0);
  });

  test('clicking Merge arms a confirm step instead of merging immediately', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    let mergeCalled = false;
    await page.route('**/api/pull-requests/merge', (route) => {
      mergeCalled = true;
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();

    await expect(
      row.getByRole('button', { name: 'Confirm merge?' }),
    ).toBeVisible();
    await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(mergeCalled).toBe(false);
  });

  // Regression test for a real bug report: a click on "Merge" read as
  // doing nothing at all, because the confirm-step swap had nothing
  // drawing the eye to it.
  test('clicking Merge moves keyboard focus to the new Confirm merge button', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();

    await expect(
      row.getByRole('button', { name: 'Confirm merge?' }),
    ).toBeFocused();
  });

  // Reported live against alrayyes/backup-git-repos#212: clicking Merge
  // then Confirm merge? did nothing. Root cause: aggregator.go sorts
  // pullRequests by UpdatedAt descending, and every live update (the
  // 30s poll, or an SSE push) rebuilds the whole board from that fresh
  // order via applySnapshot -> prBoard.setItems. Any other tracked pull
  // request updating in that window reshuffles the list out from under
  // a row that's already armed for its second click, so the confirm
  // click lands on whatever's now in that row's old position instead of
  // the button itself.
  //
  // #764: the snapshot is now delivered by the background poll, not the
  // Refresh now button, since clicking anywhere else, Refresh now included,
  // disarms the confirm on purpose. Focus is kept in the group from the
  // keyboard, which also pauses the 8 second countdown.
  test('a pull request being confirmed for merge stays in place even if a live refresh reorders the board', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    const target = makePR({ number: 42, repo: 'alrayyes/backup-git-repos' });
    await mockDashboard(page, target);
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await mergeButton(row).focus();
    await page.keyboard.press('Enter');
    await expect(
      row.getByRole('button', { name: 'Confirm merge?' }),
    ).toBeVisible();

    // A live refresh lands mid-confirmation carrying a second, more
    // recently updated pull request — the exact shape that pushes the
    // one being confirmed out of first place once the board re-sorts.
    const newer = makePR({
      number: 99,
      repo: 'alrayyes/other-repo',
      updatedAt: new Date().toISOString(),
    });
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
          pullRequests: [newer, target],
          issues: [],
        }),
      }),
    );
    await page.clock.fastForward(31_000);

    // The board stays frozen at the pre-refresh state while the row is
    // mid-interaction — the new pull request doesn't even appear yet —
    // rather than reordering out from under the armed click.
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    await expect(
      row.getByRole('button', { name: 'Confirm merge?' }),
    ).toBeVisible();

    // Cancelling clears the in-flight state, so the update that was held
    // behind the armed row is now one Show updates click away (#710).
    await row.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('#show-updates-button').click();
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);
  });

  test('Cancel returns to the plain Merge button without calling the API', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    let mergeCalled = false;
    await page.route('**/api/pull-requests/merge', (route) => {
      mergeCalled = true;
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Cancel' }).click();

    await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
    expect(mergeCalled).toBe(false);
  });

  test('confirming calls the merge API with forge/fullName/number and refreshes the board', async ({
    page,
  }) => {
    const pr = makePR();
    await mockDashboard(page, pr);
    let requestBody: unknown;
    await page.route('**/api/pull-requests/merge', (route) => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    // Once merged, the immediate refresh this triggers reports the PR
    // gone — the same way a real merge would drop it from the next
    // snapshot.
    await page.route('**/api/dashboard/refresh', (route) =>
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
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    await expect(page.locator('#pr-rows .row')).toHaveCount(0);
    expect(requestBody).toEqual({
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 42,
    });
  });

  test('shows an in-progress status while merging, then a success status', async ({
    page,
  }) => {
    const pr = makePR();
    await mockDashboard(page, pr);
    await page.route('**/api/pull-requests/merge', async (route) => {
      // Held open briefly so the in-progress status has a moment to be
      // observed before the success one replaces it.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/dashboard/refresh', (route) =>
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
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    // The row says what is happening, and a toast reports the result.
    await expect(row.locator('.wait-chip-label')).toHaveText('Merging');
    await expect(page.locator('#feedback-live')).toHaveAttribute(
      'aria-live',
      'polite',
    );
    const toast = page.locator('#feedback-toasts .feedback-toast').first();
    await expect(toast).toContainText('alrayyes/forge-dashboard#42');
    await expect(toast).toContainText('Merged.');
    await expect(page.locator('#status-banner')).toHaveCount(0);
  });

  test('a raw network failure whose refresh confirms the merge went through reports success, not a false failure', async ({
    page,
  }) => {
    // The exact shape reported live: forge-dashboard's own backend can
    // restart mid-request (a redeploy the merge itself can trigger) and
    // the browser never gets a response at all — a TypeError with no
    // HTTP status, ambiguous about whether the merge actually landed.
    // Verified against a fresh refresh rather than trusted at face value.
    const pr = makePR();
    await mockDashboard(page, pr);
    await page.route('**/api/pull-requests/merge', (route) =>
      route.abort('failed'),
    );
    await page.route('**/api/dashboard/refresh', (route) =>
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
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    await expect(page.locator('#pr-rows .row')).toHaveCount(0);
    await expect(page.locator('#error-banner')).toHaveCount(0);
    await expect(page.locator('#feedback-toasts')).toContainText(
      'alrayyes/forge-dashboard#42',
    );
    await expect(page.locator('#feedback-toasts')).toContainText('Merged.');
  });

  test('a raw network failure whose refresh shows the pull request still there reports the real failure', async ({
    page,
  }) => {
    const pr = makePR();
    await mockDashboard(page, pr);
    await page.route('**/api/pull-requests/merge', (route) =>
      route.abort('failed'),
    );
    await page.route('**/api/dashboard/refresh', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [pr],
          issues: [],
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    await expect(page.locator('#feedback-toasts')).toContainText(
      "Couldn't merge",
    );
    await expect(page.locator('#feedback-toasts')).toContainText(
      'alrayyes/forge-dashboard#42',
    );
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
  });

  test('a transient failure shows an error and returns to a re-clickable Merge button', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PUT .../merge: EOF',
          code: 'unknown',
          message: 'EOF',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const failed = page.locator(
      '#feedback-toasts .feedback-toast[data-kind="error"]',
    );
    await expect(failed).toContainText('EOF');
    // No lingering "Merging…" line once it has failed — the row says
    // Failed, not both.
    await expect(row.locator('.row-feedback')).toContainText('Failed');
    await expect(row.locator('.row-feedback')).not.toContainText('Merging…');
    await expect(page.locator('#error-banner')).toHaveCount(0);
    await expect(page.locator('#status-banner')).toHaveCount(0);
    const button = row.getByRole('button', { name: 'Merge' });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('a permission-denied failure locks the button with no Retry and points to Settings', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PUT .../merge: Forbidden',
          code: 'permission',
          message: 'Missing permission — check your token in Settings.',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    // The 403 also proactively locks Close for this forge (write
    // permission is account-wide), and neither offers a Retry.
    const button = row.getByRole('button', { name: 'Merge', exact: true });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(button).toHaveAccessibleDescription(/token in Settings/);
  });

  test('a not-mergeable (409) failure locks the button with a refresh-and-recheck reason', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PUT .../merge: Pull Request is not mergeable',
          code: 'not_mergeable',
          message: 'No longer mergeable. Refresh to see the current state.',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const button = row.getByRole('button', { name: 'Retry' });
    await expect(button).toBeVisible();
    await expect(row).toContainText(/no longer mergeable/i);
  });

  test('a 409 caused by a disallowed merge method shows the real forge message, not a generic "no longer mergeable" guess', async ({
    page,
  }) => {
    // Real bug: GitHub's merge endpoint uses the same 409 for two
    // different causes (a PR that's genuinely not mergeable, and a merge
    // method the repo doesn't allow — #349) — the old hardcoded "no
    // longer mergeable" text was simply wrong for this one.
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error:
            'github: PUT .../merge: Merge commits are not allowed on this repository.',
          code: 'not_mergeable',
          message: 'Merge commits are not allowed on this repository.',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    await expect(row.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(row).toContainText(
      'Merge commits are not allowed on this repository.',
    );
    await expect(row).not.toContainText(/no longer mergeable/i);
  });

  test('a rate-limited (429) failure locks the button with no Retry and says when it resets', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
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
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const button = row.getByRole('button', { name: 'Merge', exact: true });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(button).toHaveAccessibleDescription(/rate limit reached/i);
  });

  test('clicking Retry re-fetches the dashboard, and a stale lock clears once the fresh data no longer justifies it', async ({
    page,
  }) => {
    // The actual bug (#351): mergeState used to latch 'locked' forever —
    // only a full page reload cleared it, even after a real refresh
    // brought back data that no longer justified the lock. This is the
    // regression test for the fix, not just for the Retry button's own
    // (a 409 here: a rate limit no longer offers Retry, #732)
    // click wiring.
    const pr = makePR();
    await mockDashboard(page, pr);
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: PUT .../merge: Pull Request is not mergeable',
          code: 'not_mergeable',
          message: 'No longer mergeable. Refresh to see the current state.',
        }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();
    await expect(row.getByRole('button', { name: 'Retry' })).toBeVisible();

    let refreshCalled = false;
    await page.route('**/api/dashboard/refresh', (route) => {
      refreshCalled = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [pr],
          issues: [],
        }),
      });
    });

    await row.getByRole('button', { name: 'Retry' }).click();

    expect(refreshCalled).toBe(true);
    await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  });

  test('a locked Merge button is reachable by keyboard and has no axe-core violations', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
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
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const button = row.getByRole('button', { name: 'Merge', exact: true });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await button.focus();
    await expect(button).toBeFocused();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations with a toast showing', async ({ page }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/dashboard/refresh', (route) =>
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
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();
    await expect(
      page.locator('#feedback-toasts .feedback-toast').first(),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test.describe('proactive locking, before any click', () => {
    test('a mergeable PR on an unreachable forge draws no Merge button, Retry or pointer to a status line, and one banner says why (#1199)', async ({
      page,
    }) => {
      await mockDashboardCustom(
        page,
        [{ forge: 'github', reachable: false, repoCount: 0 }],
        [makePR()],
      );
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      await expect(row.getByText('A pull request')).toBeVisible();
      await expect(
        row.getByRole('button', { name: 'Merge', exact: true }),
      ).toHaveCount(0);
      await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
      await expect(row).not.toContainText('See the forge status above.');
      await expect(page.locator('#unreachable-banner')).toContainText(
        'GitHub is unreachable',
      );
    });

    test('a behind PR on an unreachable forge draws no action, and the banner holds the one Retry (#516, #609, #1199)', async ({
      page,
    }) => {
      await mockDashboardCustom(
        page,
        [{ forge: 'github', reachable: false, repoCount: 0 }],
        [makePR({ behind: true })],
      );
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
      await expect(row.locator('.row-action-reason')).toHaveCount(0);
      await expect(
        page
          .locator('#unreachable-banner')
          .getByRole('button', { name: 'Retry' }),
      ).toHaveCount(1);
    });

    test('a mergeable PR on a forge with an exhausted rate-limit budget draws no Merge button (#755)', async ({
      page,
    }) => {
      const resetsAt = new Date(Date.now() + 41 * 60 * 1000).toISOString();
      await mockDashboardCustom(
        page,
        [
          {
            forge: 'github',
            reachable: true,
            repoCount: 1,
            rateLimitREST: rateLimit(5000, 0, resetsAt),
          },
        ],
        [makePR()],
      );
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      await expect(row.getByText('A pull request')).toBeVisible();
      await expect(
        row.getByRole('button', { name: 'Merge', exact: true }),
      ).toHaveCount(0);
      await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
      await expect(page.locator('#rate-limit-banner')).toContainText(
        'GitHub is rate limited. Read-only until',
      );
    });

    test('a permission failure on one PR does not lock Merge for a different PR on the same forge (#918)', async ({
      page,
    }) => {
      const first = makePR({ number: 1 });
      const second = makePR({ number: 2 });
      await mockDashboardCustom(
        page,
        [{ forge: 'github', reachable: true, repoCount: 2 }],
        [first, second],
      );
      // The force refresh below answers the same board, so it never reaches the
      // real server (which has nothing to refresh for this user).
      await page.route('**/api/dashboard/refresh', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
            pullRequests: [first, second],
            issues: [],
          }),
        }),
      );
      await page.route('**/api/pull-requests/merge', (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'github: PUT .../merge: Forbidden',
            code: 'permission',
            message: 'Missing permission — check your token in Settings.',
          }),
        }),
      );
      await page.reload();

      const rows = page.locator('#pr-rows .row');
      await rows.nth(0).getByRole('button', { name: 'Merge' }).click();
      await rows.nth(0).getByRole('button', { name: 'Confirm merge?' }).click();
      await expect(
        rows.nth(0).getByRole('button', { name: 'Merge', exact: true }),
      ).toHaveAttribute('aria-disabled', 'true');

      // A refusal is about one action on one pull request. The second
      // pull request's Merge was never tried and stays a real button, even
      // after a refresh redraws the board.
      await page.locator('#force-refresh-button').click();
      const secondButton = rows
        .nth(1)
        .getByRole('button', { name: 'Merge', exact: true });
      await expect(secondButton).toBeVisible();
      await expect(secondButton).not.toHaveAttribute('aria-disabled', 'true');
    });
  });

  // #445: reported live — small row-action buttons were easy to miss,
  // landing the click on the row's own stretched link instead. The bare
  // WCAG 2.5.8 floor (24x24 CSS px) was already technically cleared
  // (measured live at 25px tall) before this fix — asserting real
  // comfort margin above that floor, not just the floor itself, is what
  // actually pins the fix rather than re-confirming a compliance number
  // that was never the problem. Measures the real rendered box rather
  // than trusting style.css's own numbers, since padding/line-height/
  // font interactions are exactly what a CSS typo could get wrong
  // without this ever turning red.
  test('the Merge button clears a comfortable target size, not just the bare WCAG 2.5.8 floor', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    const merge = row.getByRole('button', { name: 'Merge' });
    // boundingBox() doesn't wait for the element; under load the row can
    // still be rendering (#736).
    await expect(merge).toBeVisible();
    const box = await merge.boundingBox();

    expect(box).not.toBeNull();
    expect(box?.width).toBeGreaterThanOrEqual(28);
    expect(box?.height).toBeGreaterThanOrEqual(28);
  });
});
