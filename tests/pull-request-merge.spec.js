const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { registerViaInvite } = require('./register-helper');

async function registerAndSignIn(page, request, baseURL) {
  const username = `pr-merge-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'PR Merge Test User',
  );
}

function makePR(overrides) {
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

function mockDashboard(page, pr) {
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
function mockDashboardCustom(page, forges, prs) {
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

test.describe('pull request merge button', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('a mergeable pull request shows a Merge button', async ({ page }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'mergeable' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
  });

  test('a conflicting pull request shows no Merge button', async ({ page }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'conflicting' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toHaveCount(0);
  });

  test('a blocked pull request shows no Merge button', async ({ page }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'blocked' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toHaveCount(0);
  });

  // #385: GitHub's own mergeStateStatus reports CLEAN (mapped to
  // "mergeable" here) whenever branch protection doesn't mark a given
  // check as required, even while that check is still running — so a
  // PR with CI still pending could show a fully clickable Merge button
  // despite its own checks not having finished.
  test('a mergeable pull request whose CI is still running shows no Merge button', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', ci: 'pending' }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toHaveCount(0);
  });

  test('the Merge button appears once CI resolves, without a page reload', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', ci: 'pending' }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByRole('button', { name: 'Merge' })).toHaveCount(0);

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

    await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
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

  // #543/homelab/vps-docker#583: a mergeable pull request whose diff
  // against its base is already empty (content landed some other way)
  // used to show a fully clickable Merge button that quietly did nothing
  // when clicked. It now shows a disabled button explaining why, so Close
  // (always available, see pull-request-close.spec.js) reads as the one
  // real action instead of a silent dead end.
  test('an empty pull request shows a disabled Merge button explaining why, not a clickable one', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', empty: true }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    const button = row.getByRole('button', { name: 'Merge' });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/already up to date/i);
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
  test('a pull request being confirmed for merge stays in place even if a live refresh reorders the board', async ({
    page,
  }) => {
    const target = makePR({ number: 42, repo: 'alrayyes/backup-git-repos' });
    await mockDashboard(page, target);
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
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
    await page.route('**/api/dashboard/refresh', (route) =>
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
    await page.click('#force-refresh-button');

    // The board stays frozen at the pre-refresh state while the row is
    // mid-interaction — the new pull request doesn't even appear yet —
    // rather than reordering out from under the armed click.
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    await expect(
      row.getByRole('button', { name: 'Confirm merge?' }),
    ).toBeVisible();

    // Cancelling clears the in-flight state, so the board catches back
    // up to the live order right away instead of staying stale.
    await row.getByRole('button', { name: 'Cancel' }).click();
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
    let requestBody;
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

    const status = page.locator('#status-banner');
    await expect(status).toContainText('Merging alrayyes/forge-dashboard#42…');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toContainText('Merged alrayyes/forge-dashboard#42.');
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
    await expect(page.locator('#status-banner')).toContainText(
      'alrayyes/forge-dashboard#42',
    );
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

    await expect(page.locator('#error-banner')).toContainText(
      "Couldn't merge alrayyes/forge-dashboard#42",
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
        body: JSON.stringify({ error: 'github: PUT .../merge: EOF' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    await expect(page.locator('#error-banner')).toContainText('EOF');
    await expect(page.locator('#error-banner')).toHaveAttribute(
      'role',
      'alert',
    );
    // No lingering "Merging…" status once the error banner is showing —
    // otherwise both would compete for attention at once.
    await expect(page.locator('#status-banner')).toHaveCount(0);
    const button = row.getByRole('button', { name: 'Merge' });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('a permission-denied failure locks the button with a real Retry, not a dead end', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: PUT .../merge: Forbidden' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    // .first(): the 403 also proactively locks Close for this forge
    // (write permission is account-wide) - either Retry does the same thing.
    const button = row.getByRole('button', { name: 'Retry' }).first();
    await expect(button).toBeVisible();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/permission/i);
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

  test('a rate-limited (429) failure locks the button with a real Retry', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const button = row.getByRole('button', { name: 'Retry' });
    await expect(button).toBeVisible();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(/rate limit/i);
  });

  test('clicking Retry re-fetches the dashboard, and a stale lock clears once the fresh data no longer justifies it', async ({
    page,
  }) => {
    // The actual bug (#351): mergeState used to latch 'locked' forever —
    // only a full page reload cleared it, even after a real refresh
    // brought back data that no longer justified the lock. This is the
    // regression test for the fix, not just for the Retry button's own
    // click wiring.
    const pr = makePR();
    await mockDashboard(page, pr);
    await page.route('**/api/pull-requests/merge', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
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
        body: JSON.stringify({ error: 'github: rate limit exceeded' }),
      }),
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Merge' }).click();
    await row.getByRole('button', { name: 'Confirm merge?' }).click();

    const button = row.getByRole('button', { name: 'Retry' });
    await expect(button).toBeVisible();
    await button.focus();
    await expect(button).toBeFocused();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations with the status banner rendered', async ({
    page,
  }) => {
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
    await expect(page.locator('#status-banner')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test.describe('proactive locking, before any click', () => {
    test('a mergeable PR on an unreachable forge shows a locked Merge button pointing at the forge status above, not its own repeated reason (#360)', async ({
      page,
    }) => {
      await mockDashboardCustom(
        page,
        [{ forge: 'github', reachable: false, repoCount: 0 }],
        [makePR()],
      );
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      const button = row.getByRole('button', { name: 'Retry' }).first();
      await expect(button).toBeVisible();
      await expect(button).not.toHaveAttribute('aria-disabled', 'true');
      await expect(row).toContainText('See the forge status above.');
      await expect(row).not.toContainText(/unreachable/i);
    });

    test('a mergeable PR that is also behind its base branch, on an unreachable forge, shows the reason once even though Update branch, Merge and Close are all independently locked (#516)', async ({
      page,
    }) => {
      await mockDashboardCustom(
        page,
        [{ forge: 'github', reachable: false, repoCount: 0 }],
        [makePR({ behind: true })],
      );
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      // Update branch, Merge and Close are all locked for the same
      // forge-wide reason at once here — each keeps its own Retry button
      // (still independently clickable/aria-disabled), but the reason
      // text itself renders only once (#360's own principle, applied
      // within a row instead of just across rows).
      await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(3);
      await expect(row.locator('.row-action-reason')).toHaveCount(1);
      await expect(row).toContainText('See the forge status above.');
    });

    test('a mergeable PR on a forge with an exhausted rate-limit budget shows a locked Merge button', async ({
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
            rateLimitREST: { limit: 5000, remaining: 0, resetsAt },
          },
        ],
        [makePR()],
      );
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      const button = row.getByRole('button', { name: 'Retry' }).first();
      await expect(button).toBeVisible();
      await expect(row).toContainText(/rate limit exhausted/i);
    });

    test('a permission failure on one PR also locks Merge for a different, not-yet-tried PR on the same forge', async ({
      page,
    }) => {
      const first = makePR({ number: 1 });
      const second = makePR({ number: 2 });
      await mockDashboardCustom(
        page,
        [{ forge: 'github', reachable: true, repoCount: 2 }],
        [first, second],
      );
      await page.route('**/api/pull-requests/merge', (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'github: PUT .../merge: Forbidden',
          }),
        }),
      );
      await page.reload();

      const rows = page.locator('#pr-rows .row');
      await rows.nth(0).getByRole('button', { name: 'Merge' }).click();
      await rows.nth(0).getByRole('button', { name: 'Confirm merge?' }).click();
      await expect(
        rows.nth(0).getByRole('button', { name: 'Retry' }).first(),
      ).toBeVisible();

      // The second PR's own Merge button was never clicked, and never
      // itself made a request — it's locked purely from the first PR's
      // failure, because a token's write permission is an account-wide
      // property, not a per-PR one.
      const secondButton = rows
        .nth(1)
        .getByRole('button', { name: 'Retry' })
        .first();
      await expect(secondButton).toBeVisible();
      await expect(rows.nth(1)).toContainText(/permission/i);
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
    const box = await row.getByRole('button', { name: 'Merge' }).boundingBox();

    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThanOrEqual(28);
    expect(box.height).toBeGreaterThanOrEqual(28);
  });
});
