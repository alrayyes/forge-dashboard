import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// The Webhooks page status line (#webhooks-status) is a polite live region.
// A result is stale once the next action starts or a filter changes, and the
// same result twice must be a real change to the region, or a screen reader
// says nothing the second time.
// https://github.com/alrayyes/forge-dashboard/issues/1830

const REPOS = [
  { forge: 'github', fullName: 'acme/app' },
  { forge: 'forgejo', fullName: 'acme/infra' },
].map((r) => ({
  ...r,
  hasWebhook: true,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
  canManageWebhooks: true,
}));

const ENABLED = 'Enabled auto-update-branch for all 2 repos.';

async function open(page: Page, hold?: Promise<void>) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos: REPOS,
      }),
    }),
  );
  await page.route(
    '**/api/repos/auto-update-branch/*',
    async (route: Route) => {
      if (hold && route.request().url().endsWith('/disable')) await hold;
      await route.fulfill({ status: 204 });
    },
  );
  page.on('dialog', (d) => d.accept());
  await page.goto('/webhooks.html');
  await expect(page.locator('#webhooks-rows tr').first()).toBeVisible();
  // Record every text the polite live region takes on.
  await page.evaluate(() => {
    const w = window as unknown as { seen: string[] };
    w.seen = [];
    const el = document.getElementById('webhooks-status') as HTMLElement;
    new MutationObserver(() =>
      w.seen.push(el.textContent?.trim() ?? ''),
    ).observe(el, { childList: true, characterData: true, subtree: true });
  });
}

const seen = (page: Page) =>
  page.evaluate(() => (window as unknown as { seen: string[] }).seen);
const text = (page: Page) => page.locator('#webhooks-status').innerText();
const enable = (page: Page) =>
  page.getByRole('button', { name: /^Enable auto-update for/ });
const disable = (page: Page) =>
  page.getByRole('button', { name: /^Disable auto-update for/ });

test.describe('webhooks: status line', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      `webhooks-status-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'Webhooks Status',
    );
  });

  test('the old text is gone as soon as the next action starts', async ({
    page,
  }) => {
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    await open(page, hold);
    await enable(page).click();
    await expect(page.locator('#webhooks-status')).toHaveText(ENABLED);

    await disable(page).click();
    // The disable calls are held, so this is the in-flight state.
    await expect
      .poll(() => text(page))
      .toBe('Disabling auto-update-branch for acme/app…');
    expect(await text(page)).not.toContain('Enabled');
    release();
    await expect(page.locator('#webhooks-status')).toHaveText(
      'Disabled auto-update-branch for all 2 repos.',
    );
  });

  test('the same result twice is announced twice', async ({ page }) => {
    await open(page);
    for (const round of [1, 2]) {
      await enable(page).click();
      await expect(page.locator('#webhooks-status')).toHaveText(ENABLED);
      expect((await seen(page)).filter((t) => t === ENABLED)).toHaveLength(
        round,
      );
      await disable(page).click();
      await expect(page.locator('#webhooks-status')).toContainText('Disabled');
    }
  });

  test('a filter change removes a result about the earlier list', async ({
    page,
  }) => {
    await open(page);
    await enable(page).click();
    await expect(page.locator('#webhooks-status')).toHaveText(ENABLED);

    await page.locator('#webhooks-repo-filter').fill('infra');
    await expect.poll(() => text(page)).toBe('');

    await disable(page).click();
    await expect(page.locator('#webhooks-status')).toContainText('Disabled');
    await page.locator('#webhooks-status-filter').selectOption('confirmed');
    await expect.poll(() => text(page)).toBe('');
  });
});
