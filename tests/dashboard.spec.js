const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { registerViaInvite } = require('./register-helper');
const { setTheme } = require('./theme-helper');

async function registerAndSignIn(page, request, baseURL) {
  const username = `dashboard-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'Dashboard Test User',
  );
}

// The forge filter is a segmented control (radio inputs, visually hidden
// in favor of their <label>) rather than a <select> — clicking the label
// is what a real user (or a screen reader's activation gesture) does,
// same as any other radio group.
function forgeRadio(page, value) {
  return page.locator(`.filter-bar input[data-col="forge"][value="${value}"]`);
}

async function selectForge(page, value) {
  await forgeRadio(page, value).check();
}

test.describe('dashboard page', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    // The dashboard page also opens a live-updates EventSource against
    // the real, unmocked /api/dashboard/stream — any test that mocks
    // /api/dashboard itself and then reloads can otherwise have a real
    // snapshot pushed over that stream silently overwrite the mocked one
    // applied a moment earlier, flipping a reload assertion straight from
    // correct to empty with no error in between (confirmed live across
    // three separate reload-based tests in this file). 404 here also
    // just matches this account's own real behavior for a user with no
    // background refresh running (see "a user with no background refresh
    // running yet" below) — this suite never saves real settings for
    // these per-test users, so the real endpoint would 404 anyway.
    await page.route('**/api/dashboard/stream', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'no background refresh is running yet for this user',
        }),
      }),
    );
  });

  test('renders the board and answers real data from /api/dashboard', async ({
    page,
  }) => {
    await expect(page.locator('h1')).toHaveText('Forge Board');
    await expect(page.locator('#stat-prs')).not.toHaveText('–');
    await expect(page.locator('.board')).toHaveCount(2);
  });

  test('a user with no background refresh running yet still sees the dashboard, with no error banner', async ({
    page,
  }) => {
    // GET /api/dashboard/stream 404s until Settings has been saved once
    // (no Manager Aggregator running yet) — EventSource retries that on
    // its own, silently, and the poll this page also runs keeps the
    // dashboard itself working regardless. Real bug shape this guards
    // against: an unhandled SSE failure surfacing as a visible error.
    const streamResponse = await page.request.get('/api/dashboard/stream');
    expect(streamResponse.status()).toBe(404);

    await expect(page.locator('h1')).toHaveText('Forge Board');
    await expect(page.locator('#error-banner')).toHaveCount(0);
  });

  test('the footer shows the running version, fetched from /api/version', async ({
    page,
  }) => {
    // CI builds the e2e binary with no goreleaser ldflags, so this is
    // always "dev" here — a real release build shows "· vX.Y.Z" linked to
    // its GitHub release instead (see footer.js). Also carries a
    // "Release history" link now (see releases.spec.js).
    await expect(page.locator('#footer-version')).toContainText('· dev build');
  });

  test('an unreachable forge shows a friendly reason, not the raw technical string', async ({
    page,
  }) => {
    // Real incident: an unauthorized GitHub source showed only "GitHub
    // unreachable", with the actual reason (bad token, a real outage —
    // all look identical from here) buried in a title attribute nothing
    // but a mouse hover ever reaches. Fixed once by showing the raw
    // string as visible text; #229 found that raw string itself
    // unfriendly and impossible to act on, so it now sits behind a
    // details disclosure and a classified, actionable headline is what's
    // primary.
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            {
              forge: 'github',
              reachable: false,
              repoCount: 0,
              error: 'github: GET /user/repos: 401 Bad credentials',
              errorKind: 'unauthorized',
            },
          ],
          pullRequests: [],
          issues: [],
        }),
      }),
    );

    await page.reload();

    const forgeHealth = page.locator('#forge-health');
    await expect(forgeHealth).toContainText('Check the token in Settings.');

    // The raw string is present in the DOM either way (a <details>'s
    // collapsed content is still in textContent, just not rendered), so
    // "not shown by default" is asserted on the disclosure's own open
    // state, not by searching for the text's absence.
    const details = forgeHealth.locator('details.forge-health-detail');
    await expect(details).not.toHaveAttribute('open');

    await details.locator('summary').click();
    await expect(details).toHaveAttribute('open');
    await expect(forgeHealth).toContainText('401 Bad credentials');
  });

  test('a rate-limited forge does not repeat the exceeded-budget banner underneath its own chip', async ({
    page,
  }) => {
    // The per-forge headline + details disclosure above exists so a
    // classified, actionable reason replaces an unfriendly raw string —
    // but #361's rate-limit-banner already gives rate_limited a more
    // prominent, more detailed (per-budget, with a countdown) home at
    // the top of the page. Repeating "Rate limit exceeded." and a raw
    // error disclosure here on top of that is noise, not a second
    // source of detail — reported live, the text served no purpose once
    // the banner shipped.
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            {
              forge: 'github',
              reachable: false,
              repoCount: 0,
              error:
                'github: GET /user/repos: API rate limit exceeded for user ID 511318. (resets 2026-09-14T14:00:00Z)',
              errorKind: 'rate_limited',
            },
          ],
          pullRequests: [],
          issues: [],
        }),
      }),
    );

    await page.reload();

    const forgeHealth = page.locator('#forge-health');
    await expect(forgeHealth).toContainText('GitHub unreachable');
    await expect(forgeHealth).not.toContainText('Rate limit exceeded');
    await expect(
      forgeHealth.locator('details.forge-health-detail'),
    ).toHaveCount(0);
  });

  test('an unreachable forge with no recognized error kind still shows a friendly, forge-named reason', async ({
    page,
  }) => {
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            {
              forge: 'forgejo',
              reachable: false,
              repoCount: 0,
              error: 'forgejo: GET /user/repos: unexpected EOF',
              errorKind: 'unknown',
            },
          ],
          pullRequests: [],
          issues: [],
        }),
      }),
    );

    await page.reload();

    const forgeHealth = page.locator('#forge-health');
    await expect(forgeHealth).toContainText(
      'Something went wrong talking to Forgejo.',
    );
    await expect(
      forgeHealth.locator('details.forge-health-detail'),
    ).not.toHaveAttribute('open');
  });

  test('a forge reporting a healthy rate-limit budget does not show the numeric gauge here — that lives on Insights — nor the exceeded banner', async ({
    page,
  }) => {
    const resetsAt = new Date(Date.now() + 41 * 60 * 1000).toISOString();
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            {
              forge: 'github',
              reachable: true,
              repoCount: 3,
              rateLimitREST: { limit: 5000, remaining: 4922, resetsAt },
            },
          ],
          pullRequests: [],
          issues: [],
        }),
      }),
    );

    await page.reload();

    await expect(page.locator('#forge-health')).not.toContainText(
      '4922/5000 requests',
    );
    await expect(page.locator('.forge-health-ratelimit')).toHaveCount(0);
    await expect(page.locator('#rate-limit-banner')).toHaveCount(0);
  });

  test.describe('rate-limit-exceeded banner (#361)', () => {
    test('an exhausted budget shows a prominent banner at the top with a live countdown', async ({
      page,
    }) => {
      const resetsAt = new Date(Date.now() + 90 * 1000).toISOString();
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              {
                forge: 'github',
                reachable: true,
                repoCount: 3,
                rateLimitREST: { limit: 5000, remaining: 0, resetsAt },
              },
            ],
            pullRequests: [],
            issues: [],
          }),
        }),
      );

      await page.reload();

      const banner = page.locator('#rate-limit-banner');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('Rate limit exceeded');
      await expect(banner).toContainText('GitHub REST');
      await expect(banner).toContainText(/resets in 1m \d+s/);

      function totalSeconds(text) {
        const match = text.match(/resets in (?:(\d+)m )?(\d+)s/);
        expect(match).not.toBeNull();
        return Number(match[1] || 0) * 60 + Number(match[2]);
      }

      const firstSeconds = totalSeconds(await banner.textContent());

      // The countdown ticks down on its own, same interval the
      // "refreshed Xs ago" clock already uses — no need for a fresh
      // snapshot to land for the displayed time to move.
      await expect(async () => {
        const seconds = totalSeconds(await banner.textContent());
        expect(seconds).toBeLessThan(firstSeconds);
      }).toPass({ timeout: 3000 });
    });

    test('reports each exhausted budget separately when both REST and GraphQL are out', async ({
      page,
    }) => {
      const resetsAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              {
                forge: 'github',
                reachable: true,
                repoCount: 3,
                rateLimitGraphQL: { limit: 5000, remaining: 0, resetsAt },
                rateLimitREST: { limit: 5000, remaining: 0, resetsAt },
              },
            ],
            pullRequests: [],
            issues: [],
          }),
        }),
      );

      await page.reload();

      const banner = page.locator('#rate-limit-banner');
      await expect(banner.locator('.rate-limit-banner-row')).toHaveCount(2);
      await expect(banner).toContainText('GitHub GraphQL');
      await expect(banner).toContainText('GitHub REST');
    });

    test('clears once a fresh snapshot reports the budget recovered', async ({
      page,
    }) => {
      const resetsAt = new Date(Date.now() + 60 * 1000).toISOString();
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              {
                forge: 'github',
                reachable: true,
                repoCount: 3,
                rateLimitREST: { limit: 5000, remaining: 0, resetsAt },
              },
            ],
            pullRequests: [],
            issues: [],
          }),
        }),
      );

      await page.reload();
      await expect(page.locator('#rate-limit-banner')).toBeVisible();

      await page.route('**/api/dashboard/refresh', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              {
                forge: 'github',
                reachable: true,
                repoCount: 3,
                rateLimitREST: {
                  limit: 5000,
                  remaining: 5000,
                  resetsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
                },
              },
            ],
            pullRequests: [],
            issues: [],
          }),
        }),
      );
      await page.click('#force-refresh-button');

      await expect(page.locator('#rate-limit-banner')).toHaveCount(0);
    });

    test('a budget under 5% but not yet exhausted shows a distinct "running low" row, not "exceeded"', async ({
      page,
    }) => {
      const resetsAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              {
                forge: 'github',
                reachable: true,
                repoCount: 3,
                rateLimitGraphQL: { limit: 5000, remaining: 40, resetsAt },
              },
            ],
            pullRequests: [],
            issues: [],
          }),
        }),
      );

      await page.reload();

      const banner = page.locator('#rate-limit-banner');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('Rate limit running low');
      await expect(banner).toContainText('GitHub GraphQL');
      await expect(banner).toContainText('40 of 5,000 requests left');
      await expect(banner).toContainText(/resets in \d+m \d+s/);
      await expect(banner).not.toContainText('Rate limit exceeded');
    });

    test('a budget at or above 5% shows no row at all', async ({ page }) => {
      const resetsAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              {
                forge: 'github',
                reachable: true,
                repoCount: 3,
                rateLimitGraphQL: { limit: 5000, remaining: 250, resetsAt },
              },
            ],
            pullRequests: [],
            issues: [],
          }),
        }),
      );

      await page.reload();

      await expect(page.locator('#rate-limit-banner')).toHaveCount(0);
    });

    test('an exceeded budget and a low-but-not-exhausted budget both show at once, distinctly', async ({
      page,
    }) => {
      const resetsAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              {
                forge: 'github',
                reachable: true,
                repoCount: 3,
                rateLimitGraphQL: { limit: 5000, remaining: 0, resetsAt },
                rateLimitREST: { limit: 5000, remaining: 40, resetsAt },
              },
            ],
            pullRequests: [],
            issues: [],
          }),
        }),
      );

      await page.reload();

      const banner = page.locator('#rate-limit-banner');
      await expect(banner.locator('.rate-limit-banner-row')).toHaveCount(2);
      await expect(banner).toContainText(
        'Rate limit exceeded — GitHub GraphQL',
      );
      await expect(banner).toContainText(
        'Rate limit running low — GitHub REST',
      );
    });
  });

  test('the dashboard has no webhook coverage card — that lives in Settings now', async ({
    page,
  }) => {
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [],
          pullRequests: [],
          issues: [],
          repos: [
            { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
            { forge: 'github', fullName: 'alrayyes/b', hasWebhook: false },
          ],
        }),
      }),
    );

    await page.reload();

    await expect(page.locator('#webhook-coverage')).toHaveCount(0);
  });

  test('has no axe-core violations at desktop width', async ({ page }) => {
    await expect(page.locator('#stat-prs')).not.toHaveText('–');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator('#stat-prs')).not.toHaveText('–');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    const clientWidth = await page.evaluate(
      () => document.documentElement.clientWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test('has no axe-core violations with a real Forgejo forge badge rendered, light theme', async ({
    page,
  }) => {
    // Regression test for #235: every other axe-scanned fixture in this
    // file only ever used forge: 'github' rows, so a real .forge-badge.fj
    // element never actually got scanned until this one.
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
          pullRequests: [
            {
              forge: 'forgejo',
              repo: 'alrayyes/a',
              number: 1,
              title: 'A pull request',
              url: 'https://example.com/1',
              author: 'claude',
              ci: 'success',
              labels: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              mergeStatus: 'mergeable',
            },
          ],
          issues: [],
        }),
      }),
    );
    await page.reload();
    await expect(page.locator('.forge-badge.fj')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('a non-admin user never sees the Admin link, not just in the DOM but actually rendered', async ({
    page,
  }) => {
    // Real bug: admin-link.hidden = !session.isAdmin set the hidden
    // attribute correctly, but .theme-toggle's display:inline-flex beat
    // the browser's default [hidden] { display: none } regardless of
    // specificity, so the link stayed visually visible for every user.
    // toBeHidden() checks actual rendered visibility, not just the
    // attribute — an assertion on the attribute alone would have missed
    // this. The global setup registers "admin" first, so this
    // freshly-registered user is never the admin.
    await expect(page.locator('#admin-link')).toBeHidden();
  });

  test('a long title with several label chips wraps as a block instead of collapsing to single-word lines', async ({
    page,
  }) => {
    // A real bug seen live: with white-space:normal enabled at phone width
    // but the flex-row layout unchanged, long label chips (flex:none, so
    // they never shrink) squeezed .title down to a sliver, wrapping every
    // word onto its own line. flex-basis:100% on .title should force it
    // onto a full-width line of its own regardless of how many chips sit
    // beside it.
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues: [
            {
              forge: 'github',
              repo: 'alrayyes/forge-dashboard',
              number: 233,
              title:
                'Wire Uptime Kuma down-alerts to auto-file Forgejo issues so an outage always leaves a ticket trail',
              url: 'https://example.com/233',
              author: 'claude',
              labels: [
                { name: 'blocked/needs-you', color: 'd93f0b' },
                { name: 'kind/feature', color: 'a2eeef' },
                { name: 'topic/infrastructure', color: '5319e7' },
              ],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      }),
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();

    const titleCell = page.locator('#issue-rows .title-cell').first();
    const box = await titleCell.boundingBox();
    // The row is ~390px wide minus padding; a healthy title-cell spans
    // nearly all of it. The bug collapsed it to well under 100px.
    expect(box.width).toBeGreaterThan(300);

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    const clientWidth = await page.evaluate(
      () => document.documentElement.clientWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test('a truncated repo name reveals its full text on hover, via a title attribute', async ({
    page,
  }) => {
    // .repo-name truncates with CSS text-overflow: ellipsis — a title
    // attribute is what lets a mouse user actually read the full name
    // without needing a custom tooltip component, and (since the
    // truncation is purely visual CSS) a screen reader already reads
    // the untruncated text content regardless.
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues: [
            {
              forge: 'github',
              repo: 'alrayyes/an-unusually-long-repository-name-that-gets-truncated',
              number: 233,
              title: 'An issue',
              url: 'https://example.com/233',
              author: 'claude',
              labels: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      }),
    );
    await page.reload();

    const repoName = page.locator('#issue-rows .repo-name').first();
    await expect(repoName).toHaveAttribute(
      'title',
      'alrayyes/an-unusually-long-repository-name-that-gets-truncated',
    );
  });

  // #470: the hover title above recovers a truncated name, but an
  // ordinary owner/repo name shouldn't need that at all — the repo
  // column's fixed desktop width has to actually fit one.
  test('an ordinary owner/repo name is not truncated at desktop width', async ({
    page,
  }) => {
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues: [
            {
              forge: 'github',
              repo: 'alrayyes/backup-git-repos',
              number: 212,
              title: 'An issue',
              url: 'https://example.com/212',
              author: 'claude',
              labels: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      }),
    );
    await page.reload();

    const repoName = page.locator('#issue-rows .repo-name').first();
    const overflow = await repoName.evaluate(
      (el) => el.scrollWidth - el.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('per-column filters narrow the visible rows', async ({ page }) => {
    // No forges configured in this CI run, so both boards render their
    // empty state — filtering an empty board is still a real assertion:
    // the filter input accepts text and the row list stays empty rather
    // than erroring. Title, not repo/author: those are now <select>s
    // with nothing to pick from an empty board.
    const titleFilter = page.locator(
      '.filter-bar .col-filter[data-col="title"]',
    );
    await titleFilter.fill('nonexistent-title');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(0);
  });

  test('the forge filter narrows the list to one forge', async ({ page }) => {
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            { forge: 'github', reachable: true, repoCount: 1 },
            { forge: 'forgejo', reachable: true, repoCount: 1 },
          ],
          pullRequests: [
            {
              forge: 'github',
              repo: 'alrayyes/forge-dashboard',
              number: 1,
              title: 'A GitHub PR',
              url: 'https://example.com/1',
              author: 'claude',
              ci: 'success',
              labels: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              forge: 'forgejo',
              repo: 'homelab/vps-docker',
              number: 2,
              title: 'A Forgejo PR',
              url: 'https://example.com/2',
              author: 'claude',
              ci: 'success',
              labels: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          issues: [],
        }),
      }),
    );
    await page.reload();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

    await selectForge(page, 'forgejo');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    await expect(page.locator('#pr-rows > .row')).toContainText('A Forgejo PR');

    await selectForge(page, '');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
  });

  test('the "Open pull requests" stat tile reflects the active filter, not just the raw total', async ({
    page,
  }) => {
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            { forge: 'github', reachable: true, repoCount: 1 },
            { forge: 'forgejo', reachable: true, repoCount: 1 },
          ],
          pullRequests: [
            {
              forge: 'github',
              repo: 'alrayyes/forge-dashboard',
              number: 1,
              title: 'A GitHub PR',
              url: 'https://example.com/1',
              author: 'claude',
              ci: 'success',
              labels: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              forge: 'forgejo',
              repo: 'homelab/vps-docker',
              number: 2,
              title: 'A Forgejo PR',
              url: 'https://example.com/2',
              author: 'claude',
              ci: 'success',
              labels: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          issues: [],
        }),
      }),
    );
    await page.reload();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

    // Unfiltered: just the total, same as before this behavior existed.
    await expect(page.locator('#stat-prs')).toHaveText('2');

    await selectForge(page, 'forgejo');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    // Filtered: the shown count out front, the total trailing it — not
    // silently still "2", which is what made this confusing before.
    await expect(page.locator('#stat-prs')).toHaveText('1 / 2');

    await selectForge(page, '');
    await expect(page.locator('#stat-prs')).toHaveText('2');
  });

  test.describe('theme and filters persist across a reload', () => {
    test.beforeEach(async ({ page }) => {
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              { forge: 'github', reachable: true, repoCount: 1 },
              { forge: 'forgejo', reachable: true, repoCount: 1 },
            ],
            pullRequests: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 1,
                title: 'A GitHub PR',
                url: 'https://example.com/1',
                author: 'claude',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'forgejo',
                repo: 'homelab/vps-docker',
                number: 2,
                title: 'A Forgejo PR',
                url: 'https://example.com/2',
                author: 'ryan',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            issues: [],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    });

    test('a chosen theme survives a reload', async ({ page }) => {
      // theme.js applies whatever's in the cookie before first paint on
      // every load — the mechanism itself is unchanged by #352 moving
      // where theme gets set from (the header toggle) to Settings; this
      // pins that mechanism directly rather than through Settings' own
      // control, which settings.spec.js already covers.
      await setTheme(page, 'dark');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    });

    test('a select filter survives a reload, both in state and visibly in the control', async ({
      page,
    }) => {
      await selectForge(page, 'forgejo');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText(
        'A Forgejo PR',
      );
      await expect(forgeRadio(page, 'forgejo')).toBeChecked();
    });

    test('the free-text title filter survives a reload', async ({ page }) => {
      const titleFilter = page.locator(
        '.filter-bar .col-filter[data-col="title"]',
      );
      await titleFilter.fill('github');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(titleFilter).toHaveValue('github');
    });

    test('the shared forge filter persists and applies to both boards, while CI status stays scoped to pull requests only', async ({
      page,
    }) => {
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              { forge: 'github', reachable: true, repoCount: 1 },
              { forge: 'forgejo', reachable: true, repoCount: 1 },
            ],
            pullRequests: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 1,
                title: 'A GitHub PR',
                url: 'https://example.com/1',
                author: 'claude',
                ci: 'failure',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'forgejo',
                repo: 'homelab/vps-docker',
                number: 2,
                title: 'A Forgejo PR',
                url: 'https://example.com/2',
                author: 'ryan',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            issues: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 3,
                title: 'A GitHub issue',
                url: 'https://example.com/3',
                author: 'claude',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'forgejo',
                repo: 'homelab/vps-docker',
                number: 4,
                title: 'A Forgejo issue',
                url: 'https://example.com/4',
                author: 'ryan',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
      await expect(page.locator('#issue-rows > .row')).toHaveCount(2);

      // Forge is shared: picking one narrows both boards at once.
      await selectForge(page, 'github');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);

      // CI status has no equivalent on issues, so it stays scoped to the
      // pull requests board only.
      await page.selectOption(
        'section[aria-label="Open pull requests"] .col-filter[data-col="status"]',
        'failure',
      );
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);

      await page.reload();
      await expect(forgeRadio(page, 'github')).toBeChecked();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
      await expect(
        page.locator(
          'section[aria-label="Open pull requests"] .col-filter[data-col="status"]',
        ),
      ).toHaveValue('failure');
    });
  });

  test.describe('server-synced filter state (#353)', () => {
    function mockTwoForges(page) {
      return page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              { forge: 'github', reachable: true, repoCount: 1 },
              { forge: 'forgejo', reachable: true, repoCount: 1 },
            ],
            pullRequests: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 1,
                title: 'A GitHub PR',
                url: 'https://example.com/1',
                author: 'claude',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'forgejo',
                repo: 'homelab/vps-docker',
                number: 2,
                title: 'A Forgejo PR',
                url: 'https://example.com/2',
                author: 'ryan',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            issues: [],
          }),
        }),
      );
    }

    test.beforeEach(async ({ page }) => {
      await mockTwoForges(page);
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    });

    test('a discrete filter change saves to the server immediately, not just the cookie', async ({
      page,
    }) => {
      await selectForge(page, 'forgejo');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

      await expect
        .poll(
          async () => {
            const resp = await page.request.get('/api/settings/filter-state');
            const body = await resp.json();
            return body?.shared?.forge;
          },
          { timeout: 1000 },
        )
        .toBe('forgejo');
    });

    test('typing in the Title filter debounces the server save, but the local cookie updates on every keystroke', async ({
      page,
    }) => {
      const titleFilter = page.locator(
        '.filter-bar .col-filter[data-col="title"]',
      );
      await titleFilter.pressSequentially('git', { delay: 20 });

      // The cookie (this page's own fast local cache) already has it,
      // synchronously, on every keystroke — checked directly rather than
      // via a reload, which would tear down the page's own pending
      // debounce timer below before it ever got to fire.
      await expect(async () => {
        const cookie = await page.evaluate(() => document.cookie);
        expect(cookie).toContain('forge-board-filters=');
      }).toPass({ timeout: 1000 });
      const cookieValue = await page.evaluate(() => {
        const match = document.cookie.match(/forge-board-filters=([^;]*)/);
        return match ? JSON.parse(decodeURIComponent(match[1])) : null;
      });
      expect(cookieValue?.shared?.title).toBe('git');

      // The server write is what's still debounced — shortly after the
      // last keystroke it hasn't landed yet...
      const soonAfter = await page.request.get('/api/settings/filter-state');
      const soonBody = await soonAfter.json();
      expect(soonBody?.shared?.title).not.toBe('git');

      // ...but does land once the debounce window passes.
      await expect
        .poll(
          async () => {
            const resp = await page.request.get('/api/settings/filter-state');
            const body = await resp.json();
            return body?.shared?.title;
          },
          { timeout: 2000 },
        )
        .toBe('git');
    });

    test('a filter set with no local cookie present still applies once the server value loads — a new browser, same account', async ({
      page,
    }) => {
      await selectForge(page, 'forgejo');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect
        .poll(
          async () => {
            const resp = await page.request.get('/api/settings/filter-state');
            const body = await resp.json();
            return body?.shared?.forge;
          },
          { timeout: 1000 },
        )
        .toBe('forgejo');

      // A brand-new browser for this same account has a valid session
      // but never had this page's own forge-board-filters cookie — only
      // the session cookie (who the server thinks this is) survives.
      await page.evaluate(() => {
        // biome-ignore lint/suspicious/noDocumentCookie: matches filters.js's own setCookie, which this test is deliberately bypassing to simulate a fresh browser.
        document.cookie = 'forge-board-filters=; max-age=0; path=/';
      });
      await page.reload();

      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText(
        'A Forgejo PR',
      );
      await expect(forgeRadio(page, 'forgejo')).toBeChecked();
    });
  });

  test.describe('grouping', () => {
    test.beforeEach(async ({ page }) => {
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
            pullRequests: [
              {
                forge: 'github',
                repo: 'alrayyes/wiki',
                number: 1,
                title: 'Wiki PR',
                url: 'https://example.com/1',
                author: 'claude',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 2,
                title: 'Dashboard PR one',
                url: 'https://example.com/2',
                author: 'claude',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 3,
                title: 'Dashboard PR two',
                url: 'https://example.com/3',
                author: 'claude',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            issues: [],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    });

    test('off by default: the flat list is unchanged', async ({ page }) => {
      await expect(page.locator('#pr-rows > .group-heading')).toHaveCount(0);
    });

    test('group by repo clusters rows under a real heading per repo, alphabetically, with a count', async ({
      page,
    }) => {
      await page.selectOption('#shared-group-select', 'repo');

      const headings = page.locator('#pr-rows > h3.group-heading');
      await expect(headings).toHaveCount(2);
      await expect(headings.nth(0)).toContainText('alrayyes/forge-dashboard');
      await expect(headings.nth(0)).toContainText('2');
      await expect(headings.nth(1)).toContainText('alrayyes/wiki');
      await expect(headings.nth(1)).toContainText('1');

      // Still all three rows, just clustered rather than removed.
      await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    });

    test('a filter combined with grouping only clusters the repos that still have matches — no empty headings', async ({
      page,
    }) => {
      await page.selectOption('#shared-group-select', 'repo');
      await page.fill('.filter-bar .col-filter[data-col="title"]', 'Dashboard');

      await expect(page.locator('#pr-rows > h3.group-heading')).toHaveCount(1);
      await expect(page.locator('#pr-rows > h3.group-heading')).toContainText(
        'alrayyes/forge-dashboard',
      );
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    });

    test('switching back to no grouping returns to the flat list', async ({
      page,
    }) => {
      await page.selectOption('#shared-group-select', 'repo');
      await expect(page.locator('#pr-rows > h3.group-heading')).toHaveCount(2);

      await page.selectOption('#shared-group-select', '');
      await expect(page.locator('#pr-rows > h3.group-heading')).toHaveCount(0);
      await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    });

    test.describe('group by forge', () => {
      test.beforeEach(async ({ page }) => {
        await page.route('**/api/dashboard*', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              generatedAt: new Date().toISOString(),
              forges: [
                { forge: 'github', reachable: true, repoCount: 1 },
                { forge: 'forgejo', reachable: true, repoCount: 1 },
              ],
              pullRequests: [
                {
                  forge: 'github',
                  repo: 'alrayyes/forge-dashboard',
                  number: 1,
                  title: 'A GitHub PR',
                  url: 'https://example.com/1',
                  author: 'claude',
                  ci: 'success',
                  labels: [],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
                {
                  forge: 'forgejo',
                  repo: 'homelab/vps-docker',
                  number: 2,
                  title: 'A Forgejo PR one',
                  url: 'https://example.com/2',
                  author: 'claude',
                  ci: 'success',
                  labels: [],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
                {
                  forge: 'forgejo',
                  repo: 'homelab/vps-docker',
                  number: 3,
                  title: 'A Forgejo PR two',
                  url: 'https://example.com/3',
                  author: 'claude',
                  ci: 'success',
                  labels: [],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              ],
              issues: [],
            }),
          }),
        );
        await page.reload();
        await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
      });

      test('clusters rows under a real heading per forge, using the display label, alphabetically, with a count', async ({
        page,
      }) => {
        await page.selectOption('#shared-group-select', 'forge');

        const headings = page.locator('#pr-rows > h3.group-heading');
        await expect(headings).toHaveCount(2);
        // Alphabetical by display label: "Forgejo" before "GitHub".
        await expect(headings.nth(0)).toContainText('Forgejo');
        await expect(headings.nth(0)).toContainText('2');
        await expect(headings.nth(1)).toContainText('GitHub');
        await expect(headings.nth(1)).toContainText('1');
        await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
      });

      test('picking a forge while grouped by forge resets grouping to none, instead of clustering into one no-op heading', async ({
        page,
      }) => {
        // Covered in depth (option hidden, group-select value reset) by
        // "the repo/author/label filters ... stay consistent with the
        // active forge" below — this just confirms the render outcome:
        // every visible row already shares one forge once the Forge
        // filter narrows to it, so a single cluster would tell the user
        // nothing a flat list didn't already (#112).
        await page.selectOption('#shared-group-select', 'forge');
        await selectForge(page, 'github');

        await expect(page.locator('#pr-rows > h3.group-heading')).toHaveCount(
          0,
        );
        await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
        await expect(page.locator('#pr-rows > .row')).toContainText(
          'A GitHub PR',
        );
      });
    });
  });

  test.describe('repo and author filters are selects, title is autocomplete', () => {
    test.beforeEach(async ({ page }) => {
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
            pullRequests: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 1,
                title: 'One',
                url: 'https://example.com/1',
                author: 'claude',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'github',
                repo: 'alrayyes/wiki',
                number: 2,
                title: 'Two',
                url: 'https://example.com/2',
                author: 'ryan',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            issues: [],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    });

    test('the repo select lists repos actually on screen, and picking one filters to it', async ({
      page,
    }) => {
      // Only one forge represented here, so options stay flat — no
      // <optgroup> — but the value is still forge-qualified (#112).
      const options = page.locator('#shared-repo-select option');
      await expect(options).toHaveCount(3); // "All repos" plus the two.
      await expect(page.locator('#shared-repo-select optgroup')).toHaveCount(0);
      await expect(
        page.locator(
          '#shared-repo-select option[value="github:alrayyes/wiki"]',
        ),
      ).toHaveCount(1);
      await expect(
        page.locator(
          '#shared-repo-select option[value="github:alrayyes/wiki"]',
        ),
      ).toHaveText('alrayyes/wiki');

      await page.selectOption('#shared-repo-select', 'github:alrayyes/wiki');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText('Two');

      await page.selectOption('#shared-repo-select', '');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    });

    test('the author select lists authors actually on screen, and picking one filters to it', async ({
      page,
    }) => {
      await expect(page.locator('#shared-author-select option')).toHaveCount(3); // "All authors" plus the two.

      await page.selectOption('#shared-author-select', 'ryan');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText('Two');
    });

    test('the title filter offers suggestions from what is on screen, but still accepts free text', async ({
      page,
    }) => {
      const suggestions = page.locator('#shared-title-options option');
      await expect(suggestions).toHaveCount(2);
      await expect(
        page.locator('#shared-title-options option[value="Two"]'),
      ).toHaveCount(1);

      // Free text still works — the datalist only adds suggestions, it
      // doesn't restrict what can be typed.
      await page.fill('.filter-bar .col-filter[data-col="title"]', 'wo');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText('Two');
    });
  });

  test.describe('the repo/author/label filters and group-by stay consistent with the active forge', () => {
    test.beforeEach(async ({ page }) => {
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              { forge: 'github', reachable: true, repoCount: 2 },
              { forge: 'forgejo', reachable: true, repoCount: 1 },
            ],
            pullRequests: [
              {
                forge: 'github',
                repo: 'shared/tools',
                number: 1,
                title: 'GitHub A',
                url: 'https://example.com/1',
                author: 'claude',
                ci: 'success',
                labels: [{ name: 'bug', color: 'd73a4a' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'forgejo',
                repo: 'shared/tools',
                number: 2,
                title: 'Forgejo A',
                url: 'https://example.com/2',
                author: 'ryan',
                ci: 'success',
                labels: [{ name: 'enhancement', color: 'a2eeef' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'github',
                repo: 'alrayyes/only-here',
                number: 3,
                title: 'GitHub only',
                url: 'https://example.com/3',
                author: 'claude',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            issues: [],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    });

    test('the repo select groups options by forge when a repo name is shared, and resolves each to exactly one forge', async ({
      page,
    }) => {
      const groups = page.locator('#shared-repo-select optgroup');
      await expect(groups).toHaveCount(2);
      // Alphabetical by display label, same as group-by-forge's headings:
      // "Forgejo" before "GitHub".
      await expect(groups.nth(0)).toHaveAttribute('label', 'Forgejo');
      await expect(groups.nth(1)).toHaveAttribute('label', 'GitHub');

      await page.selectOption('#shared-repo-select', 'github:shared/tools');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText('GitHub A');

      await page.selectOption('#shared-repo-select', 'forgejo:shared/tools');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText('Forgejo A');
    });

    test('picking a forge narrows the repo, author, and label selects to that forge only, ungrouped', async ({
      page,
    }) => {
      await selectForge(page, 'forgejo');

      await expect(page.locator('#shared-repo-select optgroup')).toHaveCount(0);
      await expect(page.locator('#shared-repo-select option')).toHaveCount(2); // All repos + shared/tools.
      await expect(page.locator('#shared-author-select option')).toHaveCount(2); // All authors + ryan.
      await expect(page.locator('#shared-label-select option')).toHaveCount(2); // All labels + enhancement.
    });

    test('clearing the forge filter widens the repo, author, and label options back out', async ({
      page,
    }) => {
      await selectForge(page, 'forgejo');
      await selectForge(page, '');

      await expect(page.locator('#shared-repo-select optgroup')).toHaveCount(2);
      await expect(page.locator('#shared-author-select option')).toHaveCount(3); // All + claude + ryan.
      await expect(page.locator('#shared-label-select option')).toHaveCount(3); // All + bug + enhancement.
    });

    test('a repo selection that no longer exists once the forge filter narrows clears itself, not just the control', async ({
      page,
    }) => {
      await page.selectOption(
        '#shared-repo-select',
        'github:alrayyes/only-here',
      );
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

      await selectForge(page, 'forgejo');

      // "alrayyes/only-here" doesn't exist under Forgejo — the stale
      // selection has to clear, or this would silently show zero rows
      // with no visible reason why.
      await expect(page.locator('#shared-repo-select')).toHaveValue('');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText('Forgejo A');
    });

    test('an author selection that no longer exists once the forge filter narrows clears itself', async ({
      page,
    }) => {
      await page.selectOption('#shared-author-select', 'claude');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

      await selectForge(page, 'forgejo');

      await expect(page.locator('#shared-author-select')).toHaveValue('');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText('Forgejo A');
    });

    test('"Group by forge" disappears once a forge is picked, and resets an active forge grouping to none', async ({
      page,
    }) => {
      await page.selectOption('#shared-group-select', 'forge');
      await expect(page.locator('#pr-rows > .group-heading')).toHaveCount(2);
      await expect(
        page.locator('#shared-group-select option[value="forge"]'),
      ).toHaveJSProperty('hidden', false);

      await selectForge(page, 'github');

      await expect(
        page.locator('#shared-group-select option[value="forge"]'),
      ).toHaveJSProperty('hidden', true);
      await expect(page.locator('#shared-group-select')).toHaveValue('');
      await expect(page.locator('#pr-rows > .group-heading')).toHaveCount(0);

      await selectForge(page, '');
      await expect(
        page.locator('#shared-group-select option[value="forge"]'),
      ).toHaveJSProperty('hidden', false);
    });

    // #550: Repo/Author/Label mutually narrow each other's own options
    // too, not just have Forge narrow all three one-way.
    test('picking a repo narrows the author and label selects to that repo only, still respecting an active forge', async ({
      page,
    }) => {
      await selectForge(page, 'github');
      await page.selectOption('#shared-repo-select', 'github:shared/tools');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText('GitHub A');

      // Only "GitHub A" (author claude, label bug) is under github:shared/tools —
      // "GitHub only" (alrayyes/only-here) and "Forgejo A" (ryan/enhancement)
      // are excluded by forge and repo respectively.
      await expect(page.locator('#shared-author-select option')).toHaveCount(2); // All + claude.
      await expect(
        page.locator('#shared-author-select option[value="claude"]'),
      ).toHaveCount(1);
      await expect(page.locator('#shared-label-select option')).toHaveCount(2); // All + bug.
      await expect(
        page.locator('#shared-label-select option[value="bug"]'),
      ).toHaveCount(1);
    });

    test('picking an author narrows the repo and label selects to that author only', async ({
      page,
    }) => {
      await page.selectOption('#shared-author-select', 'claude');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

      // claude has "GitHub A" (github:shared/tools, label bug) and
      // "GitHub only" (github:alrayyes/only-here, no label) — ryan's
      // forgejo:shared/tools and its "enhancement" label are excluded.
      await expect(page.locator('#shared-repo-select optgroup')).toHaveCount(0);
      await expect(page.locator('#shared-repo-select option')).toHaveCount(3); // All + the two claude repos.
      await expect(
        page.locator(
          '#shared-repo-select option[value="forgejo:shared/tools"]',
        ),
      ).toHaveCount(0);
      await expect(page.locator('#shared-label-select option')).toHaveCount(2); // All + bug.
      await expect(
        page.locator('#shared-label-select option[value="enhancement"]'),
      ).toHaveCount(0);
    });

    test('picking a label narrows the repo and author selects to that label only', async ({
      page,
    }) => {
      await page.selectOption('#shared-label-select', 'bug');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText('GitHub A');

      // Only "GitHub A" (github:shared/tools, author claude) carries "bug".
      await expect(page.locator('#shared-repo-select option')).toHaveCount(2); // All + github:shared/tools.
      await expect(
        page.locator('#shared-repo-select option[value="github:shared/tools"]'),
      ).toHaveCount(1);
      await expect(page.locator('#shared-author-select option')).toHaveCount(2); // All + claude.
      await expect(
        page.locator('#shared-author-select option[value="ryan"]'),
      ).toHaveCount(0);
    });

    test('a repo+author combination that stops co-occurring clears both selections, not just one', async ({
      page,
    }) => {
      // Both picks are valid together at the time they're made: the
      // Forgejo shared/tools repo really is authored by ryan.
      await page.selectOption('#shared-repo-select', 'forgejo:shared/tools');
      await page.selectOption('#shared-author-select', 'ryan');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

      // The underlying data changes under the still-active filters (a
      // live poll/force-refresh, same shape #112 already guards against
      // for Forge) — ryan no longer has anything under forgejo/shared/
      // tools. Each select's own leave-one-out pool still respects the
      // *other* one's now-stale value at the moment this recomputes (a
      // single pass, not a fixed point), so both Repo and Author come
      // up empty and clear together rather than only Author doing so —
      // neither one, on its own, is a value still reachable given what
      // the other was set to.
      await page.route('**/api/dashboard/refresh', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              { forge: 'github', reachable: true, repoCount: 2 },
              { forge: 'forgejo', reachable: true, repoCount: 1 },
            ],
            pullRequests: [
              {
                forge: 'github',
                repo: 'shared/tools',
                number: 1,
                title: 'GitHub A',
                url: 'https://example.com/1',
                author: 'claude',
                ci: 'success',
                labels: [{ name: 'bug', color: 'd73a4a' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'forgejo',
                repo: 'shared/tools',
                number: 2,
                title: 'Forgejo A, reassigned',
                url: 'https://example.com/2',
                author: 'someone-else',
                ci: 'success',
                labels: [{ name: 'enhancement', color: 'a2eeef' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'github',
                repo: 'alrayyes/only-here',
                number: 3,
                title: 'GitHub only',
                url: 'https://example.com/3',
                author: 'claude',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            issues: [],
          }),
        }),
      );
      await page.click('#force-refresh-button');

      await expect(page.locator('#shared-repo-select')).toHaveValue('');
      await expect(page.locator('#shared-author-select')).toHaveValue('');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    });

    test('a PR-only filter like CI status is not part of the shared repo/author/label narrowing', async ({
      page,
    }) => {
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
            pullRequests: [
              {
                forge: 'github',
                repo: 'team/one',
                number: 1,
                title: 'Passing PR',
                url: 'https://example.com/1',
                author: 'claude',
                ci: 'success',
                labels: [{ name: 'bug', color: 'd73a4a' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'github',
                repo: 'team/two',
                number: 2,
                title: 'Failing PR',
                url: 'https://example.com/2',
                author: 'ryan',
                ci: 'failure',
                labels: [{ name: 'enhancement', color: 'a2eeef' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            issues: [],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

      await page.selectOption(
        'section[aria-label="Open pull requests"] .col-filter[data-col="status"]',
        'failure',
      );
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText('Failing PR');

      // The CI filter narrowed the PR board's own rows, but it's a
      // board-owned field, not a shared one — the shared Repo/Author/
      // Label selects still offer values from both PRs, including the
      // passing one CI status just hid.
      await expect(page.locator('#shared-repo-select option')).toHaveCount(3); // All + team/one + team/two.
      await expect(page.locator('#shared-author-select option')).toHaveCount(3); // All + claude + ryan.
      await expect(page.locator('#shared-label-select option')).toHaveCount(3); // All + bug + enhancement.
    });
  });

  test.describe('pagination', () => {
    function makePR(n) {
      return {
        forge: 'github',
        repo: 'alrayyes/forge-dashboard',
        number: n,
        title: `PR number ${n}`,
        url: `https://example.com/${n}`,
        author: 'claude',
        ci: 'success',
        labels: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    test('a filtered set under one page shows no pagination controls', async ({
      page,
    }) => {
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
            pullRequests: [makePR(1), makePR(2)],
            issues: [],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
      await expect(page.locator('#pr-pagination')).toBeHidden();
    });

    test('a set over one page paginates, and changing the page size re-pages from page 1', async ({
      page,
    }) => {
      var prs = [];
      var i;
      for (i = 1; i <= 30; i++) prs.push(makePR(i));

      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
            pullRequests: prs,
            issues: [],
          }),
        }),
      );
      await page.reload();

      // Default page size is 25, so 30 PRs means page 1 of 2.
      await expect(page.locator('#pr-rows > .row')).toHaveCount(25);
      await expect(page.locator('#pr-pagination')).toBeVisible();
      await expect(
        page.locator('#pr-pagination-pages .pagination-page.active'),
      ).toHaveText('1');

      await page.click('#pr-pagination-pages .pagination-page:has-text("2")');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(5);
      await expect(
        page.locator('#pr-pagination-pages .pagination-page.active'),
      ).toHaveText('2');

      // Changing page size while on page 2 resets to page 1 of the new
      // size rather than showing a confusing partial page.
      await page.selectOption('#pr-page-size', '50');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(30);
      await expect(page.locator('#pr-pagination')).toBeHidden();
    });

    test('a filter narrowing the set below one page hides pagination and resets to page 1', async ({
      page,
    }) => {
      var prs = [];
      var i;
      for (i = 1; i <= 30; i++) prs.push(makePR(i));
      prs[0].title = 'the only match';

      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
            pullRequests: prs,
            issues: [],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#pr-pagination')).toBeVisible();

      await page.fill(
        '.filter-bar .col-filter[data-col="title"]',
        'the only match',
      );
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-pagination')).toBeHidden();
    });
  });

  test.describe('CI status click-to-filter', () => {
    test.beforeEach(async ({ page }) => {
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
            pullRequests: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 1,
                title: 'A passing PR',
                url: 'https://example.com/1',
                author: 'claude',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 2,
                title: 'A failing PR',
                url: 'https://example.com/2',
                author: 'claude',
                ci: 'failure',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            issues: [],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    });

    test('clicking the "CI failing" stat tile filters to failing pull requests, and clicking it again clears the filter', async ({
      page,
    }) => {
      await page.click('#stat-failing-tile');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText(
        'A failing PR',
      );
      await expect(
        page.locator(
          'section[aria-label="Open pull requests"] .col-filter[data-col="status"]',
        ),
      ).toHaveValue('failure');

      await page.click('#stat-failing-tile');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
      await expect(
        page.locator(
          'section[aria-label="Open pull requests"] .col-filter[data-col="status"]',
        ),
      ).toHaveValue('');
    });

    test('clicking anywhere else in a row still opens the pull request, same as before the row stopped being one big <a>', async ({
      page,
    }) => {
      // force:true — the stretched-link overlay covering .repo (see
      // .title::after in style.css) is the whole point of this pattern,
      // and Playwright's actionability check refuses a plain .click() on
      // an element another one visually intercepts. A real click here
      // (mouse or touch) hits the overlay exactly the same way.
      const [popup] = await Promise.all([
        page.waitForEvent('popup'),
        page
          .locator('#pr-rows .row', { hasText: 'A passing PR' })
          .locator('.repo')
          .click({ force: true }),
      ]);
      await expect(popup).toHaveURL('https://example.com/1');
    });

    test("clicking a row's CI pill filters to that status, without also opening the PR", async ({
      page,
    }) => {
      let navigated = false;
      page.on('popup', () => {
        navigated = true;
      });

      await page
        .locator('#pr-rows .row', { hasText: 'A passing PR' })
        .locator('.ci-pill')
        .click();

      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText(
        'A passing PR',
      );
      expect(navigated).toBe(false);
    });

    test('has no axe-core violations with real rows rendered, including nested-interactive checks', async ({
      page,
    }) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });

    test('the "CI failing" tile is styled as a warning once something is actually failing', async ({
      page,
    }) => {
      // The beforeEach here has one failing PR.
      await expect(page.locator('#stat-failing-tile')).toHaveClass(/critical/);
    });
  });

  test.describe('CI pill wording for a passed pipeline', () => {
    function mockOnePR(page, overrides) {
      return page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
            pullRequests: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 1,
                title: 'A pull request',
                url: 'https://example.com/1',
                author: 'claude',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                ...overrides,
              },
            ],
            issues: [],
          }),
        }),
      );
    }

    // "Passing" reads fine right next to a big Merge button prompting
    // action on the same row — "Passed" there would just be a second,
    // redundant way of saying "ready." Once there's no merge action on
    // the row for CI to sit beside, "Passed" is the plainer, more
    // finished-sounding word — matching GitHub's and GitLab's own
    // terminal-state convention (both say "passed", not "passing", for
    // a completed successful run).
    test('shows "Passing" when a Merge button is also on the row', async ({
      page,
    }) => {
      await mockOnePR(page, { mergeStatus: 'mergeable' });
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
      await expect(row.locator('.ci-pill')).toContainText('Passing');
    });

    test('shows "Passed" once there is no Merge button on the row', async ({
      page,
    }) => {
      await mockOnePR(page, { mergeStatus: 'blocked' });
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      await expect(row.getByRole('button', { name: 'Merge' })).toHaveCount(0);
      await expect(row.locator('.ci-pill')).toContainText('Passed');
    });

    test('a failing or running pipeline is worded the same regardless of the Merge button', async ({
      page,
    }) => {
      await mockOnePR(page, { mergeStatus: 'mergeable', ci: 'failure' });
      await page.reload();

      const row = page.locator('#pr-rows .row').first();
      await expect(row.locator('.ci-pill')).toContainText('Failing');
    });
  });

  test('the "CI failing" tile is not styled as a warning when the count is zero', async ({
    page,
  }) => {
    // Real bug reported live: the tile carried a static "critical" class
    // in the markup, so "0 failing" read as an alarm — red for good news.
    await page.route('**/api/dashboard*', (route) =>
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

    await expect(page.locator('#stat-failing')).toHaveText('0');
    await expect(page.locator('#stat-failing-tile')).not.toHaveClass(
      /critical/,
    );
  });

  test('the "CI failing" tile reads as good news, in a themed color, when the count is zero', async ({
    page,
  }) => {
    // Real bug reported live: "CI failing" is the one stat tile that's a
    // real <button> (the other three are plain <div>s), and a <button>
    // doesn't inherit text color from the page the way a div does — with
    // no explicit color set, it fell back to the browser's native
    // ButtonText system color, black regardless of theme, once the
    // "critical" class stopped overriding it at zero. Only visible in
    // dark mode, where black-on-dark-surface is barely readable; light
    // mode's own default ink is dark too, so this passed unnoticed there.
    await page.route('**/api/dashboard*', (route) =>
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
    await setTheme(page, 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await expect(page.locator('#stat-failing')).toHaveText('0');
    await expect(page.locator('#stat-failing-tile')).toHaveClass(/\bok\b/);
    const color = await page
      .locator('#stat-failing')
      .evaluate((el) => getComputedStyle(el).color);
    // --good in dark mode (style.css) — not black, and not the same as
    // an ordinary stat's default ink color either.
    expect(color).toBe('rgb(56, 201, 138)');
  });

  test.describe('merge status and auto-merge pills', () => {
    function pr(overrides = {}) {
      return {
        forge: 'github',
        repo: 'alrayyes/forge-dashboard',
        number: 1,
        title: 'A pull request',
        url: 'https://example.com/1',
        author: 'claude',
        ci: 'success',
        labels: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        mergeStatus: 'mergeable',
        ...overrides,
      };
    }

    function mockDashboard(page, pullRequests) {
      return page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
            pullRequests,
            issues: [],
          }),
        }),
      );
    }

    test('a clean, non-auto-merge pull request shows neither pill', async ({
      page,
    }) => {
      await mockDashboard(page, [pr()]);
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

      await expect(page.locator('.merge-pill')).toHaveCount(0);
    });

    test('a conflicting pull request shows the blocked/conflict pill', async ({
      page,
    }) => {
      await mockDashboard(page, [pr({ mergeStatus: 'conflicting' })]);
      await page.reload();

      const pill = page.locator('#pr-rows .merge-pill.conflicting');
      await expect(pill).toHaveCount(1);
      await expect(pill).toContainText('Conflicting');
    });

    test('a blocked pull request shows the blocked pill', async ({ page }) => {
      await mockDashboard(page, [pr({ mergeStatus: 'blocked' })]);
      await page.reload();

      const pill = page.locator('#pr-rows .merge-pill.blocked');
      await expect(pill).toHaveCount(1);
      await expect(pill).toContainText('Blocked');
    });

    // #418: GitHub's own mergeStateStatus reports BLOCKED whenever
    // required checks haven't *completed*, not only once one has
    // actually failed — the same root cause #385 already fixed for the
    // Merge button's own clickability. This is the separate status pill
    // sitting next to the CI pill, showing the exact same false "Blocked"
    // signal while CI just hasn't finished yet.
    test('a blocked pull request whose CI is still running shows no blocked pill', async ({
      page,
    }) => {
      await mockDashboard(page, [
        pr({ mergeStatus: 'blocked', ci: 'pending' }),
      ]);
      await page.reload();

      await expect(page.locator('#pr-rows .merge-pill.blocked')).toHaveCount(0);
    });

    test('the blocked pill appears once CI resolves to a real block', async ({
      page,
    }) => {
      await mockDashboard(page, [
        pr({ mergeStatus: 'blocked', ci: 'failure' }),
      ]);
      await page.reload();

      const pill = page.locator('#pr-rows .merge-pill.blocked');
      await expect(pill).toHaveCount(1);
      await expect(pill).toContainText('Blocked');
    });

    test('a conflicting pull request shows the conflict pill even while CI is still running — a real conflict, not a completion gate', async ({
      page,
    }) => {
      await mockDashboard(page, [
        pr({ mergeStatus: 'conflicting', ci: 'pending' }),
      ]);
      await page.reload();

      const pill = page.locator('#pr-rows .merge-pill.conflicting');
      await expect(pill).toHaveCount(1);
      await expect(pill).toContainText('Conflicting');
    });

    test('a pull request with auto-merge enabled shows the auto-merge pill', async ({
      page,
    }) => {
      await mockDashboard(page, [pr({ autoMergeEnabled: true })]);
      await page.reload();

      const pill = page.locator('#pr-rows .merge-pill.auto-merge');
      await expect(pill).toHaveCount(1);
      await expect(pill).toContainText('Auto-merge');
    });

    test('auto-merge not reported by the forge shows no pill, not a false "not enabled"', async ({
      page,
    }) => {
      // autoMergeEnabled omitted entirely — the Forgejo case, since the
      // SDK has no read capability for it at all.
      await mockDashboard(page, [pr({ forge: 'forgejo' })]);
      await page.reload();

      await expect(page.locator('.merge-pill.auto-merge')).toHaveCount(0);
    });

    test('has no axe-core violations with both pills rendered', async ({
      page,
    }) => {
      // Regression test for #305: mergeStatus: 'blocked' was never
      // actually included here, so its pill's real WCAG AA contrast
      // failure went uncaught until a different test happened to combine
      // it with a scan.
      await mockDashboard(page, [
        pr({ number: 1, mergeStatus: 'conflicting' }),
        pr({ number: 2, autoMergeEnabled: true }),
        pr({ number: 3, mergeStatus: 'blocked' }),
      ]);
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(3);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });

  test.describe('force-refresh button', () => {
    test('clicking it calls the endpoint and updates the dashboard from its response', async ({
      page,
    }) => {
      await page.route('**/api/dashboard*', (route) =>
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
      await expect(page.locator('#stat-prs')).toHaveText('0');

      let refreshCalled = false;
      await page.route('**/api/dashboard/refresh', (route) => {
        refreshCalled = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
            pullRequests: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 1,
                title: 'A fresh PR',
                url: 'https://example.com/1',
                author: 'claude',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            issues: [],
          }),
        });
      });

      await page.click('#force-refresh-button');
      expect(refreshCalled).toBe(true);
      await expect(page.locator('#stat-prs')).toHaveText('1');
      await expect(page.locator('#pr-rows > .row')).toContainText('A fresh PR');
    });

    test('disables itself immediately, and re-enables after the cooldown once the response has landed', async ({
      page,
    }) => {
      await page.route('**/api/dashboard/refresh', async (route) => {
        // Held open briefly so the "is-refreshing" spin class — added
        // synchronously on click, removed once the response is in hand
        // — has a real window to be observed before it's gone again.
        // Without this, a mocked route can resolve within the same
        // tick as the click, and the assertion below races the class's
        // own removal instead of ever seeing it (#413).
        await new Promise((resolve) => setTimeout(resolve, 200));
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [],
            pullRequests: [],
            issues: [],
          }),
        });
      });

      const button = page.locator('#force-refresh-button');
      await expect(button).toBeEnabled();

      await button.click();
      await expect(button).toBeDisabled();
      await expect(button).toHaveClass(/is-refreshing/);

      // The spin class comes off once the response is in hand, but the
      // button itself stays disabled through the cooldown that follows.
      await expect(button).not.toHaveClass(/is-refreshing/);
      await expect(button).toBeDisabled();

      await expect(button).toBeEnabled({ timeout: 8000 });
    });

    test('a failed refresh shows the existing error banner rather than failing silently', async ({
      page,
    }) => {
      await page.route('**/api/dashboard/refresh', (route) =>
        route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'no background refresh is running yet for this user',
          }),
        }),
      );

      await page.click('#force-refresh-button');
      await expect(page.locator('#error-banner')).toBeVisible();
      await expect(page.locator('#error-banner')).toContainText(
        'Could not refresh',
      );
    });

    test('is hidden while viewing a dashboard someone else shared', async ({
      page,
    }) => {
      await page.route('**/api/sharing', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sharedWithMe: [
              { username: 'someone-else', displayName: 'Someone Else' },
            ],
          }),
        }),
      );
      await page.reload();

      await expect(page.locator('#force-refresh-button')).toBeVisible();

      await expect(page.locator('#dashboard-owner-select')).toBeVisible();
      await page.selectOption('#dashboard-owner-select', 'someone-else');

      await expect(page.locator('#force-refresh-button')).toBeHidden();

      await page.selectOption('#dashboard-owner-select', '');
      await expect(page.locator('#force-refresh-button')).toBeVisible();
    });
  });

  test.describe('label click-to-filter', () => {
    test.beforeEach(async ({ page }) => {
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
            pullRequests: [],
            issues: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 1,
                title: 'A bug report',
                url: 'https://example.com/1',
                author: 'claude',
                labels: [{ name: 'kind/bug', color: 'd73a4a' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 2,
                title: 'A feature request',
                url: 'https://example.com/2',
                author: 'claude',
                labels: [{ name: 'kind/feature', color: 'a2eeef' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(2);
    });

    test('clicking a label chip filters to that label, marks the chip active, and clicking it again clears the filter', async ({
      page,
    }) => {
      const bugChip = page
        .locator('#issue-rows .row', { hasText: 'A bug report' })
        .locator('.label-chip', { hasText: 'kind/bug' });
      await bugChip.click();

      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
      await expect(page.locator('#issue-rows > .row')).toContainText(
        'A bug report',
      );
      await expect(bugChip).toHaveClass(/active/);
      await expect(bugChip).toHaveAttribute('aria-pressed', 'true');

      await bugChip.click();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(2);
      await expect(bugChip).not.toHaveClass(/active/);
    });

    test('clicking a label chip does not also open the issue', async ({
      page,
    }) => {
      let navigated = false;
      page.on('popup', () => {
        navigated = true;
      });

      await page
        .locator('#issue-rows .row', { hasText: 'A bug report' })
        .locator('.label-chip')
        .click();

      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
      expect(navigated).toBe(false);
    });

    test('label filtering is shared: clicking a chip on the issues board also filters the pull requests board', async ({
      page,
    }) => {
      // Label is one of the shared fields now — override the fixture with
      // a matching-labeled PR so this actually exercises the cross-board
      // effect, not just an already-empty PR board staying empty.
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
            pullRequests: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 3,
                title: 'A PR fixing a bug',
                url: 'https://example.com/3',
                author: 'claude',
                ci: 'success',
                labels: [{ name: 'kind/bug', color: 'd73a4a' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 4,
                title: 'An unrelated PR',
                url: 'https://example.com/4',
                author: 'claude',
                ci: 'success',
                labels: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            issues: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 1,
                title: 'A bug report',
                url: 'https://example.com/1',
                author: 'claude',
                labels: [{ name: 'kind/bug', color: 'd73a4a' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 2,
                title: 'A feature request',
                url: 'https://example.com/2',
                author: 'claude',
                labels: [{ name: 'kind/feature', color: 'a2eeef' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
      await expect(page.locator('#issue-rows > .row')).toHaveCount(2);

      await page
        .locator('#issue-rows .label-chip', { hasText: 'kind/bug' })
        .click();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText(
        'A PR fixing a bug',
      );
    });

    test('has no axe-core violations with real label chips rendered', async ({
      page,
    }) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });

    test('the label select lists labels actually on screen, and picking one filters and marks the matching chip active', async ({
      page,
    }) => {
      const options = page.locator('#shared-label-select option');
      await expect(options).toHaveCount(3); // "All labels" plus the two.

      await page.selectOption('#shared-label-select', 'kind/bug');
      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
      await expect(page.locator('#issue-rows > .row')).toContainText(
        'A bug report',
      );
      const bugChip = page
        .locator('#issue-rows .row', { hasText: 'A bug report' })
        .locator('.label-chip', { hasText: 'kind/bug' });
      await expect(bugChip).toHaveClass(/active/);

      await page.selectOption('#shared-label-select', '');
      await expect(page.locator('#issue-rows > .row')).toHaveCount(2);
    });

    test('clicking a label chip keeps the select in sync', async ({ page }) => {
      await page
        .locator('#issue-rows .label-chip', { hasText: 'kind/bug' })
        .click();
      await expect(page.locator('#shared-label-select')).toHaveValue(
        'kind/bug',
      );

      await page
        .locator('#issue-rows .label-chip', { hasText: 'kind/bug' })
        .click();
      await expect(page.locator('#shared-label-select')).toHaveValue('');
    });

    test('a label beyond the first three chips on an item is still clearable via the select, even with no chip on screen to click', async ({
      page,
    }) => {
      // Real bug this guards against: titleCell only ever renders the
      // first three labels per item. Filtering to a label that isn't
      // among an item's first three never renders a chip for it at all
      // — before the select existed, there was nothing left to click to
      // undo the filter.
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
            pullRequests: [],
            issues: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 1,
                title: 'Many labels',
                url: 'https://example.com/1',
                author: 'claude',
                labels: [
                  { name: 'a', color: 'd73a4a' },
                  { name: 'b', color: 'a2eeef' },
                  { name: 'c', color: '7057ff' },
                  { name: 'kind/buried', color: '008672' },
                ],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);

      await page.selectOption('#shared-label-select', 'kind/buried');
      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
      // Only the first three labels render a chip — the filtered-on one
      // genuinely has no chip anywhere on screen right now.
      await expect(
        page.locator('#issue-rows .label-chip', { hasText: 'kind/buried' }),
      ).toHaveCount(0);

      // Still clearable, with no chip to click.
      await page.selectOption('#shared-label-select', '');
      await expect(page.locator('#shared-label-select')).toHaveValue('');
    });
  });

  test.describe('label colors', () => {
    test('a label chip renders with its real background color and a contrasting text color', async ({
      page,
    }) => {
      await page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
            pullRequests: [],
            issues: [
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 1,
                title: 'A dark-label issue',
                url: 'https://example.com/1',
                author: 'claude',
                labels: [{ name: 'kind/bug', color: '5319e7' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                forge: 'github',
                repo: 'alrayyes/forge-dashboard',
                number: 2,
                title: 'A light-label issue',
                url: 'https://example.com/2',
                author: 'claude',
                labels: [{ name: 'kind/docs', color: 'fef2c0' }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        }),
      );
      await page.reload();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(2);

      const darkChip = page.locator('#issue-rows .label-chip', {
        hasText: 'kind/bug',
      });
      await expect(darkChip).toHaveCSS('background-color', 'rgb(83, 25, 231)');
      await expect(darkChip).toHaveCSS('color', 'rgb(255, 255, 255)');

      const lightChip = page.locator('#issue-rows .label-chip', {
        hasText: 'kind/docs',
      });
      await expect(lightChip).toHaveCSS(
        'background-color',
        'rgb(254, 242, 192)',
      );
      await expect(lightChip).toHaveCSS('color', 'rgb(0, 0, 0)');
    });
  });

  test.describe('Dependency Dashboard filter', () => {
    var DEPENDENCY_DASHBOARD_ISSUE = {
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 1,
      title: 'Dependency Dashboard',
      url: 'https://example.com/1',
      author: 'renovate[bot]',
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    var REAL_ISSUE = {
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 2,
      title: 'A real bug report',
      url: 'https://example.com/2',
      author: 'someone',
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    function mockDashboard(page, { pullRequests = [], issues = [] } = {}) {
      return page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
            pullRequests,
            issues,
          }),
        }),
      );
    }

    test.beforeEach(async ({ page }) => {
      await mockDashboard(page, {
        issues: [DEPENDENCY_DASHBOARD_ISSUE, REAL_ISSUE],
      });
      await page.reload();
      // The default-on Hide Dependency Dashboard filter is already
      // narrowing the board, so the count reads "shown of total" rather
      // than the raw total — same as any other active filter.
      await expect(page.locator('#issue-count')).toHaveText('1 of 2 shown');
      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    });

    test('is hidden from the issues board by default, without hiding a real issue', async ({
      page,
    }) => {
      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
      await expect(page.locator('#issue-rows > .row')).toContainText(
        'A real bug report',
      );
      await expect(page.locator('#issue-rows')).not.toContainText(
        'Dependency Dashboard',
      );
    });

    test('unchecking the toggle brings it back, and checking it again hides it', async ({
      page,
    }) => {
      var toggle = page.locator('#issue-hide-dependency-dashboard');
      await expect(toggle).toBeChecked();

      await toggle.uncheck();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(2);

      await toggle.check();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    });

    test('has no effect on the pull requests board', async ({ page }) => {
      await mockDashboard(page, {
        pullRequests: [
          {
            forge: 'github',
            repo: 'alrayyes/forge-dashboard',
            number: 3,
            title: 'Dependency Dashboard',
            url: 'https://example.com/3',
            author: 'someone',
            draft: false,
            labels: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ci: 'none',
          },
        ],
      });
      await page.reload();

      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(
        page
          .locator('section[aria-label="Open pull requests"]')
          .locator('#issue-hide-dependency-dashboard'),
      ).toHaveCount(0);
    });

    test('the choice persists across a reload', async ({ page }) => {
      await page.locator('#issue-hide-dependency-dashboard').uncheck();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(2);

      await page.reload();

      await expect(
        page.locator('#issue-hide-dependency-dashboard'),
      ).not.toBeChecked();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(2);
    });
  });

  test.describe('Clear filters button (#354)', () => {
    var PR_ONE = {
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 1,
      title: 'Add NTP alarm',
      url: 'https://example.com/1',
      author: 'ryan',
      draft: false,
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ci: 'success',
    };
    var PR_TWO = {
      forge: 'github',
      repo: 'alrayyes/wiki',
      number: 2,
      title: 'Fix build',
      url: 'https://example.com/2',
      author: 'someone-else',
      draft: false,
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ci: 'failure',
    };
    var DEPENDENCY_DASHBOARD_ISSUE = {
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 3,
      title: 'Dependency Dashboard',
      url: 'https://example.com/3',
      author: 'renovate[bot]',
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    function mockDashboard(page) {
      return page.route('**/api/dashboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
            pullRequests: [PR_ONE, PR_TWO],
            issues: [DEPENDENCY_DASHBOARD_ISSUE],
          }),
        }),
      );
    }

    test.beforeEach(async ({ page }) => {
      await mockDashboard(page);
      await page.reload();
    });

    test('is visible but disabled with no filters active', async ({ page }) => {
      var button = page.getByRole('button', { name: 'Clear filters' });
      await expect(button).toBeVisible();
      await expect(button).toBeDisabled();
    });

    test('becomes enabled once a shared filter is active, and stays enabled for CI status/Hide Dependency Dashboard alone too', async ({
      page,
    }) => {
      var button = page.getByRole('button', { name: 'Clear filters' });

      await page.fill('.filter-bar .col-filter[data-col="title"]', 'alarm');
      await expect(button).toBeEnabled();

      await page.fill('.filter-bar .col-filter[data-col="title"]', '');
      await expect(button).toBeDisabled();

      await page.selectOption(
        'section[aria-label="Open pull requests"] .col-filter[data-col="status"]',
        'failure',
      );
      await expect(button).toBeEnabled();
    });

    test('clicking resets every shared filter, group-by, CI status, and Hide Dependency Dashboard in one action, re-renders both boards, resets pagination, and disables itself again', async ({
      page,
    }) => {
      await page.fill('.filter-bar .col-filter[data-col="title"]', 'alarm');
      await page.selectOption('#shared-group-select', 'repo');
      await page.selectOption(
        'section[aria-label="Open pull requests"] .col-filter[data-col="status"]',
        'failure',
      );
      await page.locator('#issue-hide-dependency-dashboard').uncheck();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(0); // title+status together match neither PR
      // The shared title filter also applies to issues, so even with
      // Hide Dependency Dashboard unchecked, "alarm" still excludes it —
      // confirms the shared filter and the board-owned extra combine
      // rather than either alone deciding visibility.
      await expect(page.locator('#issue-rows > .row')).toHaveCount(0);

      var button = page.getByRole('button', { name: 'Clear filters' });
      await expect(button).toBeEnabled();
      await button.click();

      await expect(button).toBeDisabled();
      await expect(
        page.locator('.filter-bar .col-filter[data-col="title"]'),
      ).toHaveValue('');
      await expect(page.locator('#shared-group-select')).toHaveValue('');
      await expect(
        page.locator(
          'section[aria-label="Open pull requests"] .col-filter[data-col="status"]',
        ),
      ).toHaveValue('');
      await expect(
        page.locator('#issue-hide-dependency-dashboard'),
      ).toBeChecked();
      // Both PRs are back (no title/status filter), the Dependency
      // Dashboard issue is hidden again (its own default).
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
      await expect(page.locator('#issue-rows > .row')).toHaveCount(0);
    });

    test('the cleared state persists across a reload', async ({ page }) => {
      await page.fill('.filter-bar .col-filter[data-col="title"]', 'alarm');
      await page.getByRole('button', { name: 'Clear filters' }).click();

      await page.reload();

      await expect(
        page.getByRole('button', { name: 'Clear filters' }),
      ).toBeDisabled();
      await expect(
        page.locator('.filter-bar .col-filter[data-col="title"]'),
      ).toHaveValue('');
    });

    test('has no axe-core violations with the button enabled', async ({
      page,
    }) => {
      await page.fill('.filter-bar .col-filter[data-col="title"]', 'alarm');
      await expect(
        page.getByRole('button', { name: 'Clear filters' }),
      ).toBeEnabled();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });
});

test.describe('login page', () => {
  test('has no axe-core violations at desktop width', async ({ page }) => {
    await page.goto('/login.html');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login.html');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    const clientWidth = await page.evaluate(
      () => document.documentElement.clientWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
