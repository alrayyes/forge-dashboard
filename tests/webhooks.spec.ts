import crypto from 'node:crypto';
import http from 'node:http';
import { type APIRequestContext, expect, type Page } from '@playwright/test';
import { landOnPullRequests, test } from './server-fixture';

declare global {
  interface Window {
    __testSSEMessages: string[];
    __testES: EventSource;
  }
}

interface FakeIssue {
  number: number;
  title: string;
  html_url: string;
  user: { login: string };
  created_at?: string;
  updated_at?: string;
}

interface FakeForgejo {
  server: http.Server;
  url: string;
}

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
function startFakeForgejo(issues: FakeIssue[]): Promise<FakeForgejo> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const page = url.searchParams.get('page');
    const reply = (body: unknown) => {
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
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('fake forgejo is not listening on a TCP port');
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

test.describe('webhook-triggered live updates', () => {
  test.beforeEach(async ({ page }) => {
    await landOnPullRequests(page);
  });

  test('a verified webhook delivery pushes a live snapshot to the open dashboard over SSE', async ({
    page,
  }) => {
    // .invalid is reserved (RFC 2606) to never resolve — a real, fast
    // failure from the forge client, not a hang, which is the point: this
    // proves the push fires off Service.RefreshNow itself, not off
    // whichever forge actually answered.
    // settings.js populates the form from a fetch that fires as part of
    // navigation, not after it — waiting for the response only after
    // goto() resolves can miss it entirely if it was already fast enough
    // to finish during the navigation itself. Racing the two together
    // instead means the listener is attached before the fetch can happen.
    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/v1/settings')),
      page.goto('/settings.html#connections'),
    ]);
    await page.fill('#forgejo-url', 'https://forgejo.example.invalid');
    await page.fill('#forgejo-username', 'octocat');
    await page.click('#save-connections-button');
    await expect(page.locator('#connections-status')).toHaveText('Saved.');

    const webhookURL = await page.locator('#webhook-url-forgejo').inputValue();
    const secret = await page.locator('#webhook-secret').inputValue();

    await page.goto('/pull-requests.html');

    // A second, independent EventSource opened from inside the page —
    // rather than asserting on app.js's own rendering (already covered
    // elsewhere), this is a direct, timing-independent check that a
    // webhook delivery is what pushes a new event, not a coincidence with
    // the regular poll interval.
    await page.evaluate(() => {
      window.__testSSEMessages = [];
      window.__testES = new EventSource('/api/v1/dashboard/stream');
      window.__testES.onmessage = (e: MessageEvent<string>) =>
        window.__testSSEMessages.push(e.data);
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
      // settings.js populates the form from a fetch that fires as part of
      // navigation, not after it — waiting for the response only after
      // goto() resolves can miss it entirely if it was already fast enough
      // to finish during the navigation itself. Racing the two together
      // instead means the listener is attached before the fetch can happen.
      await Promise.all([
        page.waitForResponse((res) => res.url().includes('/api/v1/settings')),
        page.goto('/settings.html#connections'),
      ]);
      await page.fill('#forgejo-url', forgejoURL);
      await page.fill('#forgejo-token', 'fj_test_token');
      await page.click('#save-connections-button');
      await expect(page.locator('#connections-status')).toHaveText('Saved.');

      const webhookURL = await page
        .locator('#webhook-url-forgejo')
        .inputValue();
      const secret = await page.locator('#webhook-secret').inputValue();

      // The page opens its stream after the first poll (#1569); the response
      // headers come once the server has subscribed it, so the webhook below
      // can't fire before the stream is there to hear it.
      const streamUp = page.waitForResponse((res) =>
        res.url().includes('/api/v1/dashboard/stream'),
      );
      await page.goto('/issues.html');
      await expect(page.locator('#issue-rows')).toContainText('existing issue');
      await streamUp;

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
});
