const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');

async function registerAndSignIn(page) {
  await addVirtualAuthenticator(page);
  const username = 'dashboard-test-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', 'Dashboard Test User');
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

test.describe('dashboard page', () => {
  test.beforeEach(async ({ page }) => {
    await registerAndSignIn(page);
  });

  test('renders the board and answers real data from /api/dashboard', async ({ page }) => {
    await expect(page.locator('h1')).toHaveText('Forge Board');
    await expect(page.locator('#stat-prs')).not.toHaveText('–');
    await expect(page.locator('.board')).toHaveCount(2);
  });

  test('a user with no background refresh running yet still sees the dashboard, with no error banner', async ({ page }) => {
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

  test('the footer shows the running version, fetched from /api/version', async ({ page }) => {
    // CI builds the e2e binary with no goreleaser ldflags, so this is
    // always "dev" here — a real release build shows "· vX.Y.Z" linked to
    // its GitHub release instead (see footer.js). Also carries a
    // "Release history" link now (see releases.spec.js).
    await expect(page.locator('#footer-version')).toContainText('· dev build');
  });

  test('has no axe-core violations at desktop width', async ({ page }) => {
    await expect(page.locator('#stat-prs')).not.toHaveText('–');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator('#stat-prs')).not.toHaveText('–');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test('a non-admin user never sees the Admin link, not just in the DOM but actually rendered', async ({ page }) => {
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

  test('theme toggle switches data-theme on the root element', async ({ page }) => {
    const root = page.locator('html');
    await expect(root).not.toHaveAttribute('data-theme', 'dark');
    await page.click('#theme-toggle');
    await expect(root).toHaveAttribute('data-theme', 'dark');
  });

  test('a long title with several label chips wraps as a block instead of collapsing to single-word lines', async ({ page }) => {
    // A real bug seen live: with white-space:normal enabled at phone width
    // but the flex-row layout unchanged, long label chips (flex:none, so
    // they never shrink) squeezed .title down to a sliver, wrapping every
    // word onto its own line. flex-basis:100% on .title should force it
    // onto a full-width line of its own regardless of how many chips sit
    // beside it.
    await page.route('**/api/dashboard*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [{
          forge: 'github',
          repo: 'alrayyes/forge-dashboard',
          number: 233,
          title: 'Wire Uptime Kuma down-alerts to auto-file Forgejo issues so an outage always leaves a ticket trail',
          url: 'https://example.com/233',
          author: 'claude',
          labels: [{ name: 'blocked/needs-you', color: 'd93f0b' }, { name: 'kind/feature', color: 'a2eeef' }, { name: 'topic/infrastructure', color: '5319e7' }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      }),
    }));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();

    const titleCell = page.locator('#issue-rows .title-cell').first();
    const box = await titleCell.boundingBox();
    // The row is ~390px wide minus padding; a healthy title-cell spans
    // nearly all of it. The bug collapsed it to well under 100px.
    expect(box.width).toBeGreaterThan(300);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test('per-column filters narrow the visible rows', async ({ page }) => {
    // No forges configured in this CI run, so both boards render their
    // empty state — filtering an empty board is still a real assertion:
    // the filter input accepts text and the row list stays empty rather
    // than erroring.
    const repoFilter = page.locator('section[aria-label="Open pull requests"] .col-filter[data-col="repo"]');
    await repoFilter.fill('nonexistent-repo');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(0);
  });

  test('the forge filter narrows the list to one forge', async ({ page }) => {
    await page.route('**/api/dashboard*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }, { forge: 'forgejo', reachable: true, repoCount: 1 }],
        pullRequests: [
          { forge: 'github', repo: 'alrayyes/forge-dashboard', number: 1, title: 'A GitHub PR', url: 'https://example.com/1', author: 'claude', ci: 'success', labels: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { forge: 'forgejo', repo: 'homelab/vps-docker', number: 2, title: 'A Forgejo PR', url: 'https://example.com/2', author: 'claude', ci: 'success', labels: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ],
        issues: [],
      }),
    }));
    await page.reload();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

    await page.selectOption('section[aria-label="Open pull requests"] .col-filter[data-col="forge"]', 'forgejo');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    await expect(page.locator('#pr-rows > .row')).toContainText('A Forgejo PR');

    await page.selectOption('section[aria-label="Open pull requests"] .col-filter[data-col="forge"]', '');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
  });

  test.describe('group by repo', () => {
    test.beforeEach(async ({ page }) => {
      await page.route('**/api/dashboard*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
          pullRequests: [
            { forge: 'github', repo: 'alrayyes/wiki', number: 1, title: 'Wiki PR', url: 'https://example.com/1', author: 'claude', ci: 'success', labels: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
            { forge: 'github', repo: 'alrayyes/forge-dashboard', number: 2, title: 'Dashboard PR one', url: 'https://example.com/2', author: 'claude', ci: 'success', labels: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
            { forge: 'github', repo: 'alrayyes/forge-dashboard', number: 3, title: 'Dashboard PR two', url: 'https://example.com/3', author: 'claude', ci: 'success', labels: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          ],
          issues: [],
        }),
      }));
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    });

    test('off by default: the flat list is unchanged', async ({ page }) => {
      await expect(page.locator('#pr-rows > .repo-group-heading')).toHaveCount(0);
    });

    test('grouping clusters rows under a real heading per repo, alphabetically, with a count', async ({ page }) => {
      await page.check('#pr-group-toggle');

      const headings = page.locator('#pr-rows > h3.repo-group-heading');
      await expect(headings).toHaveCount(2);
      await expect(headings.nth(0)).toContainText('alrayyes/forge-dashboard');
      await expect(headings.nth(0)).toContainText('2');
      await expect(headings.nth(1)).toContainText('alrayyes/wiki');
      await expect(headings.nth(1)).toContainText('1');

      // Still all three rows, just clustered rather than removed.
      await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    });

    test('a filter combined with grouping only clusters the repos that still have matches — no empty headings', async ({ page }) => {
      await page.check('#pr-group-toggle');
      await page.fill('section[aria-label="Open pull requests"] .col-filter[data-col="title"]', 'Dashboard');

      await expect(page.locator('#pr-rows > h3.repo-group-heading')).toHaveCount(1);
      await expect(page.locator('#pr-rows > h3.repo-group-heading')).toContainText('alrayyes/forge-dashboard');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    });

    test('unchecking the toggle returns to the flat list', async ({ page }) => {
      await page.check('#pr-group-toggle');
      await expect(page.locator('#pr-rows > h3.repo-group-heading')).toHaveCount(2);

      await page.uncheck('#pr-group-toggle');
      await expect(page.locator('#pr-rows > h3.repo-group-heading')).toHaveCount(0);
      await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    });
  });

  test('the repo filter is a combobox listing repos actually on screen, and still accepts free text', async ({ page }) => {
    await page.route('**/api/dashboard*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
        pullRequests: [
          { forge: 'github', repo: 'alrayyes/forge-dashboard', number: 1, title: 'One', url: 'https://example.com/1', author: 'claude', ci: 'success', labels: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { forge: 'github', repo: 'alrayyes/wiki', number: 2, title: 'Two', url: 'https://example.com/2', author: 'claude', ci: 'success', labels: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ],
        issues: [],
      }),
    }));
    await page.reload();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

    const options = page.locator('#pr-repo-options option');
    await expect(options).toHaveCount(2);
    await expect(page.locator('#pr-repo-options option[value="alrayyes/forge-dashboard"]')).toHaveCount(1);
    await expect(page.locator('#pr-repo-options option[value="alrayyes/wiki"]')).toHaveCount(1);

    // Free text still works exactly as before — the datalist only adds
    // suggestions, it doesn't restrict what can be typed.
    await page.fill('section[aria-label="Open pull requests"] .col-filter[data-col="repo"]', 'wiki');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    await expect(page.locator('#pr-rows > .row')).toContainText('Two');
  });

  test.describe('pagination', () => {
    function makePR(n) {
      return {
        forge: 'github', repo: 'alrayyes/forge-dashboard', number: n, title: 'PR number ' + n,
        url: 'https://example.com/' + n, author: 'claude', ci: 'success', labels: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
    }

    test('a filtered set under one page shows no pagination controls', async ({ page }) => {
      await page.route('**/api/dashboard*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [makePR(1), makePR(2)],
          issues: [],
        }),
      }));
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
      await expect(page.locator('#pr-pagination')).toBeHidden();
    });

    test('a set over one page paginates, and changing the page size re-pages from page 1', async ({ page }) => {
      var prs = [];
      for (var i = 1; i <= 30; i++) prs.push(makePR(i));

      await page.route('**/api/dashboard*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: prs,
          issues: [],
        }),
      }));
      await page.reload();

      // Default page size is 25, so 30 PRs means page 1 of 2.
      await expect(page.locator('#pr-rows > .row')).toHaveCount(25);
      await expect(page.locator('#pr-pagination')).toBeVisible();
      await expect(page.locator('#pr-pagination-pages .pagination-page.active')).toHaveText('1');

      await page.click('#pr-pagination-pages .pagination-page:has-text("2")');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(5);
      await expect(page.locator('#pr-pagination-pages .pagination-page.active')).toHaveText('2');

      // Changing page size while on page 2 resets to page 1 of the new
      // size rather than showing a confusing partial page.
      await page.selectOption('#pr-page-size', '50');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(30);
      await expect(page.locator('#pr-pagination')).toBeHidden();
    });

    test('a filter narrowing the set below one page hides pagination and resets to page 1', async ({ page }) => {
      var prs = [];
      for (var i = 1; i <= 30; i++) prs.push(makePR(i));
      prs[0].title = 'the only match';

      await page.route('**/api/dashboard*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: prs,
          issues: [],
        }),
      }));
      await page.reload();
      await expect(page.locator('#pr-pagination')).toBeVisible();

      await page.fill('section[aria-label="Open pull requests"] .col-filter[data-col="title"]', 'the only match');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-pagination')).toBeHidden();
    });
  });

  test.describe('CI status click-to-filter', () => {
    test.beforeEach(async ({ page }) => {
      await page.route('**/api/dashboard*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [
            { forge: 'github', repo: 'alrayyes/forge-dashboard', number: 1, title: 'A passing PR', url: 'https://example.com/1', author: 'claude', ci: 'success', labels: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
            { forge: 'github', repo: 'alrayyes/forge-dashboard', number: 2, title: 'A failing PR', url: 'https://example.com/2', author: 'claude', ci: 'failure', labels: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          ],
          issues: [],
        }),
      }));
      await page.reload();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    });

    test('clicking the "CI failing" stat tile filters to failing pull requests, and clicking it again clears the filter', async ({ page }) => {
      await page.click('#stat-failing-tile');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText('A failing PR');
      await expect(page.locator('section[aria-label="Open pull requests"] .col-filter[data-col="status"]')).toHaveValue('failure');

      await page.click('#stat-failing-tile');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
      await expect(page.locator('section[aria-label="Open pull requests"] .col-filter[data-col="status"]')).toHaveValue('');
    });

    test('clicking anywhere else in a row still opens the pull request, same as before the row stopped being one big <a>', async ({ page }) => {
      // force:true — the stretched-link overlay covering .repo (see
      // .title::after in style.css) is the whole point of this pattern,
      // and Playwright's actionability check refuses a plain .click() on
      // an element another one visually intercepts. A real click here
      // (mouse or touch) hits the overlay exactly the same way.
      const [popup] = await Promise.all([
        page.waitForEvent('popup'),
        page.locator('#pr-rows .row', { hasText: 'A passing PR' }).locator('.repo').click({ force: true }),
      ]);
      await expect(popup).toHaveURL('https://example.com/1');
    });

    test('clicking a row\'s CI pill filters to that status, without also opening the PR', async ({ page }) => {
      let navigated = false;
      page.on('popup', () => { navigated = true; });

      await page.locator('#pr-rows .row', { hasText: 'A passing PR' }).locator('.ci-pill').click();

      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(page.locator('#pr-rows > .row')).toContainText('A passing PR');
      expect(navigated).toBe(false);
    });

    test('has no axe-core violations with real rows rendered, including nested-interactive checks', async ({ page }) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });

  test.describe('label click-to-filter', () => {
    test.beforeEach(async ({ page }) => {
      await page.route('**/api/dashboard*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues: [
            { forge: 'github', repo: 'alrayyes/forge-dashboard', number: 1, title: 'A bug report', url: 'https://example.com/1', author: 'claude', labels: [{ name: 'kind/bug', color: 'd73a4a' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
            { forge: 'github', repo: 'alrayyes/forge-dashboard', number: 2, title: 'A feature request', url: 'https://example.com/2', author: 'claude', labels: [{ name: 'kind/feature', color: 'a2eeef' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          ],
        }),
      }));
      await page.reload();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(2);
    });

    test('clicking a label chip filters to that label, marks the chip active, and clicking it again clears the filter', async ({ page }) => {
      const bugChip = page.locator('#issue-rows .row', { hasText: 'A bug report' }).locator('.label-chip', { hasText: 'kind/bug' });
      await bugChip.click();

      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
      await expect(page.locator('#issue-rows > .row')).toContainText('A bug report');
      await expect(bugChip).toHaveClass(/active/);
      await expect(bugChip).toHaveAttribute('aria-pressed', 'true');

      await bugChip.click();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(2);
      await expect(bugChip).not.toHaveClass(/active/);
    });

    test('clicking a label chip does not also open the issue', async ({ page }) => {
      let navigated = false;
      page.on('popup', () => { navigated = true; });

      await page.locator('#issue-rows .row', { hasText: 'A bug report' }).locator('.label-chip').click();

      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
      expect(navigated).toBe(false);
    });

    test('label filtering on the issues board never touches the pull requests board', async ({ page }) => {
      await page.locator('#issue-rows .label-chip', { hasText: 'kind/bug' }).click();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
      // No pull requests in this fixture at all — still renders its own
      // empty state rather than erroring because a sibling board filtered.
      await expect(page.locator('#pr-empty')).toBeVisible();
    });

    test('has no axe-core violations with real label chips rendered', async ({ page }) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });

  test.describe('label colors', () => {
    test('a label chip renders with its real background color and a contrasting text color', async ({ page }) => {
      await page.route('**/api/dashboard*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues: [
            { forge: 'github', repo: 'alrayyes/forge-dashboard', number: 1, title: 'A dark-label issue', url: 'https://example.com/1', author: 'claude', labels: [{ name: 'kind/bug', color: '5319e7' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
            { forge: 'github', repo: 'alrayyes/forge-dashboard', number: 2, title: 'A light-label issue', url: 'https://example.com/2', author: 'claude', labels: [{ name: 'kind/docs', color: 'fef2c0' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          ],
        }),
      }));
      await page.reload();
      await expect(page.locator('#issue-rows > .row')).toHaveCount(2);

      const darkChip = page.locator('#issue-rows .label-chip', { hasText: 'kind/bug' });
      await expect(darkChip).toHaveCSS('background-color', 'rgb(83, 25, 231)');
      await expect(darkChip).toHaveCSS('color', 'rgb(255, 255, 255)');

      const lightChip = page.locator('#issue-rows .label-chip', { hasText: 'kind/docs' });
      await expect(lightChip).toHaveCSS('background-color', 'rgb(254, 242, 192)');
      await expect(lightChip).toHaveCSS('color', 'rgb(0, 0, 0)');
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

  test('has no axe-core violations and no horizontal scroll at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login.html');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
