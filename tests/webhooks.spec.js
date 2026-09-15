const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const http = require('node:http');
const { addVirtualAuthenticator } = require('./webauthn-helper');

// startFakeForgejo runs a real, controllable HTTP server standing in for a
// Forgejo instance — the backend's own forgejo.Client (code.gitea.io/sdk/gitea)
// talks to it exactly as it would the real API. A page.route() mock only
// ever intercepts the browser's own fetches; it can't stand in for what the
// Go server itself calls out to, and this test's whole point is proving
// that a real webhook-triggered scoped fetch (Aggregator.RefreshRepo →
// GenericSource.FetchRepo) picks up a repo's current state, not a canned
// frontend response. issues starts as the caller's own array reference, so
// pushing a new one before firing the webhook is enough to change what the
// next fetch answers with — closer to a real "someone just opened a ticket"
// than reconfiguring a route mid-test.
function startFakeForgejo(issues) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const page = url.searchParams.get('page');
    const reply = (body) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/v1/user/repos') {
      if (page && page !== '1') return reply([]);
      return reply([
        {
          full_name: 'acme/widgets',
          name: 'widgets',
          owner: { login: 'acme' },
          permissions: { push: true },
        },
      ]);
    }
    if (url.pathname === '/api/v1/repos/acme/widgets/pulls') {
      return reply([]);
    }
    if (url.pathname === '/api/v1/repos/acme/widgets/issues') {
      if (page && page !== '1') return reply([]);
      return reply(issues);
    }
    res.statusCode = 404;
    reply({ message: 'not found in this test fixture' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

async function registerAndSignIn(page) {
  await addVirtualAuthenticator(page);
  const username = `webhooks-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', 'Webhooks Test User');
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

test.describe('webhook-triggered live updates', () => {
  test.beforeEach(async ({ page }) => {
    await registerAndSignIn(page);
  });

  test('a verified webhook delivery pushes a live snapshot to the open dashboard over SSE', async ({
    page,
  }) => {
    // .invalid is reserved (RFC 2606) to never resolve — a real, fast
    // failure from the forge client, not a hang, which is the point: this
    // proves the push fires off Manager.RefreshNow itself, not off
    // whichever forge actually answered.
    await page.goto('/settings.html');
    await page.fill('#forgejo-url', 'https://forgejo.example.invalid');
    await page.fill('#forgejo-username', 'octocat');
    await page.click('#save-button');
    await expect(page.locator('#status')).toHaveText('Saved.');

    const webhookURL = await page.locator('#webhook-url-forgejo').inputValue();
    const secret = await page.locator('#webhook-secret').inputValue();

    await page.goto('/');

    // A second, independent EventSource opened from inside the page —
    // rather than asserting on app.js's own rendering (already covered
    // elsewhere), this is a direct, timing-independent check that a
    // webhook delivery is what pushes a new event, not a coincidence with
    // the regular poll interval.
    await page.evaluate(() => {
      window.__testSSEMessages = [];
      window.__testES = new EventSource('/api/dashboard/stream');
      window.__testES.onmessage = (e) => window.__testSSEMessages.push(e.data);
    });
    await expect
      .poll(() => page.evaluate(() => window.__testES.readyState))
      .toBe(1 /* OPEN */);

    const body = JSON.stringify({
      zen: 'a real delivery carries an event, unparsed here',
    });
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    const res = await page.request.post(webhookURL, {
      headers: {
        'Content-Type': 'application/json',
        'X-Forgejo-Signature': signature,
      },
      data: body,
    });
    expect(res.status()).toBe(204);

    await expect
      .poll(() => page.evaluate(() => window.__testSSEMessages.length))
      .toBeGreaterThan(0);

    const pushed = await page.evaluate(() =>
      JSON.parse(window.__testSSEMessages[0]),
    );
    expect(pushed.forges).toEqual([
      expect.objectContaining({ forge: 'forgejo', reachable: false }),
    ]);

    // The same push reaches app.js's own EventSource and re-renders the
    // dashboard, no reload needed — assert the visible effect too, not
    // just that a message arrived.
    await expect(page.locator('#forge-health')).toContainText(
      'Forgejo unreachable',
    );
  });

  test('a webhook delivery with a bad signature is refused and never triggers a refresh', async ({
    page,
  }) => {
    await page.goto('/settings.html');
    await page.fill('#forgejo-url', 'https://forgejo.example.invalid');
    await page.fill('#forgejo-username', 'octocat');
    await page.click('#save-button');
    await expect(page.locator('#status')).toHaveText('Saved.');

    const webhookURL = await page.locator('#webhook-url-forgejo').inputValue();

    const res = await page.request.post(webhookURL, {
      headers: {
        'Content-Type': 'application/json',
        'X-Forgejo-Signature': 'not-the-real-signature',
      },
      data: JSON.stringify({ zen: 'forged' }),
    });

    expect(res.status()).toBe(401);
  });

  test('a webhook naming a repo pushes a newly created issue to the dashboard live, no reload', async ({
    page,
  }) => {
    const issues = [
      {
        number: 1,
        title: 'existing issue',
        html_url: 'https://forgejo.example/acme/widgets/issues/1',
        user: { login: 'acme' },
      },
    ];
    const { server, url: forgejoURL } = await startFakeForgejo(issues);

    try {
      await page.goto('/settings.html');
      await page.fill('#forgejo-url', forgejoURL);
      await page.fill('#forgejo-token', 'fj_test_token');
      await page.click('#save-button');
      await expect(page.locator('#status')).toHaveText('Saved.');

      const webhookURL = await page
        .locator('#webhook-url-forgejo')
        .inputValue();
      const secret = await page.locator('#webhook-secret').inputValue();

      await page.goto('/');
      await expect(page.locator('#issue-rows')).toContainText('existing issue');

      // The moment being reproduced: someone opens a new ticket on the
      // tracked repo. Nothing here refetches on its own — the dashboard
      // only sees this once the webhook below fires.
      issues.push({
        number: 2,
        title: 'a ticket just opened',
        html_url: 'https://forgejo.example/acme/widgets/issues/2',
        user: { login: 'acme' },
      });

      const body = JSON.stringify({
        action: 'opened',
        issue: { number: 2, title: 'a ticket just opened' },
        repository: {
          full_name: 'acme/widgets',
          name: 'widgets',
          owner: { login: 'acme' },
        },
      });
      const signature = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');

      const res = await page.request.post(webhookURL, {
        headers: {
          'Content-Type': 'application/json',
          'X-Forgejo-Signature': signature,
        },
        data: body,
      });
      expect(res.status()).toBe(204);

      // No page.reload() and no page.goto() between the webhook firing and
      // this assertion — only the live SSE push (or, failing that, the
      // regular poll) can be what makes this pass.
      await expect(page.locator('#issue-rows')).toContainText(
        'a ticket just opened',
        { timeout: 5000 },
      );
      // The repo's other issue should still be there too — a scoped
      // refresh replaces this repo's own entries, it doesn't drop them.
      await expect(page.locator('#issue-rows')).toContainText('existing issue');
    } finally {
      server.close();
    }
  });

  test('a newly created issue sorts to page 1 even with 25+ older issues already tracked', async ({
    page,
  }) => {
    // The board's default page size is 25 (dashboard.spec.js) — 30 older
    // issues is enough to guarantee a naive "just append" merge would
    // knock the new one off the first page, the real incident this is a
    // regression test for: a webhook firing for a repo pushed that
    // repo's whole block of issues to the end of an otherwise-unsorted
    // list.
    const older = Array.from({ length: 30 }, (_, i) => ({
      number: i + 1,
      title: `old issue ${i + 1}`,
      html_url: `https://forgejo.example/acme/widgets/issues/${i + 1}`,
      user: { login: 'acme' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }));
    const issues = [...older];
    const { server, url: forgejoURL } = await startFakeForgejo(issues);

    try {
      await page.goto('/settings.html');
      await page.fill('#forgejo-url', forgejoURL);
      await page.fill('#forgejo-token', 'fj_test_token');
      await page.click('#save-button');
      await expect(page.locator('#status')).toHaveText('Saved.');

      const webhookURL = await page
        .locator('#webhook-url-forgejo')
        .inputValue();
      const secret = await page.locator('#webhook-secret').inputValue();

      await page.goto('/');
      await expect(page.locator('#issue-rows')).toContainText('old issue 1');

      issues.push({
        number: 31,
        title: 'brand new ticket',
        html_url: 'https://forgejo.example/acme/widgets/issues/31',
        user: { login: 'acme' },
        created_at: '2026-09-15T12:00:00Z',
        updated_at: '2026-09-15T12:00:00Z',
      });

      const body = JSON.stringify({
        action: 'opened',
        issue: { number: 31, title: 'brand new ticket' },
        repository: {
          full_name: 'acme/widgets',
          name: 'widgets',
          owner: { login: 'acme' },
        },
      });
      const signature = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');

      const res = await page.request.post(webhookURL, {
        headers: {
          'Content-Type': 'application/json',
          'X-Forgejo-Signature': signature,
        },
        data: body,
      });
      expect(res.status()).toBe(204);

      // Page 1, the default view — no clicking "next" — must show the
      // brand new ticket. If it only sorts to the end of an unsorted
      // list, it lands on page 2 instead and this fails.
      await expect(page.locator('#issue-rows')).toContainText(
        'brand new ticket',
        { timeout: 5000 },
      );
    } finally {
      server.close();
    }
  });
});
