const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const http = require('node:http');
const { registerViaInvite } = require('./register-helper');
const {
  STORAGE_STATE_PATH: ADMIN_STORAGE_STATE,
} = require('./admin-global-setup');

function uniqueUsername(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// startFakeForgejo is the same minimal shape webhooks.spec.js's own
// startFakeForgejo uses — a real, controllable HTTP server standing in
// for a Forgejo instance, since a page.route() mock only intercepts the
// browser's own fetches and can't stand in for what the Go server
// itself calls out to. An empty repo list is enough here: this test's
// whole point is that the outbound call itself gets logged, not what
// its response contained.
function startFakeForgejo() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([]));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

test.describe('admin area — outbound request log', () => {
  test('a real outbound request shows up in the admin request log, filterable by forge and account, with a matching CSV export', async ({
    browser,
    request,
    baseURL,
  }) => {
    const username = uniqueUsername('admin-requests-test');
    const { server, url: forgejoURL } = await startFakeForgejo();

    const userContext = await browser.newContext();
    try {
      const userPage = await userContext.newPage();
      await registerViaInvite(
        userPage,
        request,
        baseURL,
        username,
        'Requests Test User',
      );

      // settings.js populates the form from a fetch that fires as part
      // of navigation, not after it — racing the two together means the
      // listener is attached before the fetch can happen (same reason
      // webhooks.spec.js does this).
      await Promise.all([
        userPage.waitForResponse((res) => res.url().includes('/api/settings')),
        userPage.goto('/settings.html'),
      ]);
      await userPage.fill('#forgejo-url', forgejoURL);
      await userPage.fill('#forgejo-token', 'fj_test_token');
      await userPage.click('#save-button');
      await expect(userPage.locator('#status')).toHaveText('Saved.');

      // Landing on the dashboard with Forgejo now configured is the
      // real outbound request this whole test is actually about —
      // internal/forgejo's own client, not a stub, hitting the fake
      // server above and recording the round trip to the request log.
      await Promise.all([
        userPage.waitForResponse(
          (res) =>
            res.request().method() === 'GET' &&
            res.url().includes('/api/dashboard') &&
            !res.url().includes('/refresh') &&
            !res.url().includes('/stream'),
        ),
        userPage.goto('/'),
      ]);

      const adminContext = await browser.newContext({
        storageState: ADMIN_STORAGE_STATE,
      });
      try {
        const adminPage = await adminContext.newPage();
        await adminPage.goto('/admin.html');
        await expect(adminPage.locator('#request-rows')).toContainText(
          'forgejo',
          { timeout: 10000 },
        );
        await expect(adminPage.locator('#request-rows')).toContainText(
          username,
        );

        // axe-core scan with the table actually populated by this
        // test's own row — an empty Outbound requests card would pass
        // trivially and never exercise the new markup (rules/a11y.md).
        const results = await new AxeBuilder({ page: adminPage })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);

        // Filtering to this account (the dropdown option is the
        // username, not the internal account id — see
        // QueryRequestLogAccount's own doc comment) narrows the table
        // to just this user's own rows.
        await adminPage.selectOption('#request-filter-account', username);
        await expect(adminPage.locator('#request-rows')).toContainText(
          username,
        );
        const rows = adminPage.locator('#request-rows tr');
        const rowCount = await rows.count();
        expect(rowCount).toBeGreaterThan(0);
        for (let i = 0; i < rowCount; i++) {
          await expect(rows.nth(i)).toContainText(username);
        }

        // The Export CSV link carries the same filter the table itself
        // is currently showing, so a download always matches what's on
        // screen.
        const exportHref = await adminPage
          .locator('#export-requests-link')
          .getAttribute('href');
        expect(exportHref).toContain(`account=${encodeURIComponent(username)}`);

        const exportRes = await adminPage.request.get(exportHref);
        expect(exportRes.status()).toBe(200);
        expect(exportRes.headers()['content-type']).toContain('text/csv');
        const csv = await exportRes.text();
        expect(csv).toContain(username);
        expect(csv.split('\n').filter(Boolean).length).toBe(rowCount + 1);
      } finally {
        await adminContext.close();
      }
    } finally {
      await userContext.close();
      server.close();
    }
  });

  test('the admin page itself narrows to nothing for an unrecognized account filter, with no axe-core violations on the empty state', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext({
      storageState: ADMIN_STORAGE_STATE,
    });
    try {
      const adminPage = await adminContext.newPage();
      await adminPage.goto('/admin.html');
      await adminPage.evaluate(() => {
        // No such username was ever registered, so this <option> has to
        // be added by hand — the dropdown only ever lists usernames
        // this instance's own request log has actually seen (see
        // requestAccountOptions in the page's own script).
        const select = document.querySelector('#request-filter-account');
        const opt = document.createElement('option');
        opt.value = 'no-such-user-at-all';
        opt.textContent = 'no-such-user-at-all';
        select.appendChild(opt);
      });
      await adminPage.selectOption(
        '#request-filter-account',
        'no-such-user-at-all',
      );

      await expect(adminPage.locator('#requests-empty-state')).toBeVisible({
        timeout: 10000,
      });
      await expect(adminPage.locator('#request-rows tr')).toHaveCount(0);

      const results = await new AxeBuilder({ page: adminPage })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    } finally {
      await adminContext.close();
    }
  });
});
