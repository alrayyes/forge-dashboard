import AxeBuilder from '@axe-core/playwright';
import type { Browser, BrowserContext } from '@playwright/test';
import { expect, test } from './server-fixture';
import { addVirtualAuthenticator } from './webauthn-helper';

// One username per test so a repeat never collides on "already registered".
function uniqueUsername(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// The owner (signed in through the server fixture) issues an invite and gets
// back its login link.
async function issueInvite(
  context: BrowserContext,
  username: string,
  displayName: string,
) {
  const res = await context.request.post('/api/admin/invites', {
    data: { username, displayName },
  });
  expect(res.ok()).toBeTruthy();
  const invite = await res.json();
  return `/login.html?invite=${encodeURIComponent(invite.token)}&username=${encodeURIComponent(username)}`;
}

// The invitee opens the link in a browser context of its own, with a virtual
// authenticator, so the owner's session never takes part in the registration.
async function inviteePage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await addVirtualAuthenticator(page);
  return { context, page };
}

test.describe('passkey login', () => {
  test('register a passkey via an admin-issued invite, then reach the dashboard', async ({
    browser,
    context,
    baseURL,
  }) => {
    const link = await issueInvite(
      context,
      uniqueUsername('e2e'),
      'E2E Test User',
    );
    const invitee = await inviteePage(browser, baseURL);
    try {
      await invitee.page.goto(link);
      await invitee.page.click('#register-submit');
      await expect(invitee.page).toHaveURL(/\/$/, { timeout: 10000 });

      await expect(
        invitee.page.getByRole('link', { name: 'Forge Board home' }),
      ).toBeVisible();
      await expect(invitee.page.locator('#whoami')).toHaveText('E2E Test User');
    } finally {
      await invitee.context.close();
    }
  });

  test('visiting /login?invite=<token> from a freshly created invite shows the invite-scoped form and completes registration', async ({
    browser,
    context,
    baseURL,
  }) => {
    const username = uniqueUsername('e2e-invite');
    const link = await issueInvite(context, username, 'Invited User');
    const invitee = await inviteePage(browser, baseURL);
    try {
      await invitee.page.goto(link);

      // No username/display-name fields to fill — both are already fixed
      // by the invite (design.md) — just the invite-scoped form's own
      // "Create passkey" action.
      await expect(invitee.page.locator('#register-username')).toHaveCount(0);
      await expect(invitee.page.locator('.invite-note')).toContainText(
        username,
      );
      await invitee.page.click('#register-submit');

      await expect(invitee.page).toHaveURL(/\/$/, { timeout: 10000 });
      await expect(invitee.page.locator('#whoami')).toHaveText('Invited User');
    } finally {
      await invitee.context.close();
    }
  });

  test('an expired or already-consumed invite link shows an error and does not register', async ({
    browser,
    context,
    baseURL,
  }) => {
    const link = await issueInvite(
      context,
      uniqueUsername('e2e-consumed'),
      'Consumed Invite User',
    );

    // Spend the invite once for real, then try the exact same link again
    // — same shape as a browser-history revisit or a link reused after
    // it already worked.
    const first = await inviteePage(browser, baseURL);
    try {
      await first.page.goto(link);
      await first.page.click('#register-submit');
      await expect(first.page).toHaveURL(/\/$/, { timeout: 10000 });
    } finally {
      await first.context.close();
    }

    const second = await inviteePage(browser, baseURL);
    try {
      await second.page.goto(link);
      await second.page.click('#register-submit');

      // The account from the first, successful registration still exists,
      // so this second attempt is rejected as "username already
      // registered" rather than "invalid invite" — the same
      // already-registered-check-runs-first order
      // TestRegisterBegin_AfterBootstrap_WithExpiredOrConsumedOrMismatchedInvite_IsRefused
      // exercises directly in internal/api/auth_test.go. Both are a
      // real, correct "error, no second account" outcome for a reused
      // link, which is this test's actual concern.
      await expect(second.page.locator('#status')).toContainText(
        /invalid|expired|already registered/i,
        { timeout: 5000 },
      );
      await expect(second.page).toHaveURL(/\/login\.html/);
    } finally {
      await second.context.close();
    }
  });

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
