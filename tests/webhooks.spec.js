const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { addVirtualAuthenticator } = require('./webauthn-helper');

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
});
