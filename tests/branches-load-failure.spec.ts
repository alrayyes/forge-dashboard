import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// Branches showed a failed load as a neutral note, unlike the other pages'
// red banner with the shared wording. It now shows the same .error-banner.
// https://github.com/alrayyes/forge-dashboard/issues/3272

type Mode = 'http500' | 'abort' | 'ok';

const GOOD = {
  generatedAt: new Date().toISOString(),
  counts: { failed: 0, passed: 1, running: 0, none: 0, total: 1 },
  branches: [
    {
      forge: 'github',
      fullName: 'acme/web',
      url: 'https://example.com/acme/web',
      branch: 'main',
      status: 'passed',
      commit: {
        sha: 'd98f3c2',
        subject: 'fix: a change',
        author: 'sre-dev',
        committedAt: new Date().toISOString(),
      },
      failingJobs: [],
      finishedAt: new Date().toISOString(),
      durationSeconds: 252,
      runUrl: 'https://example.com/acme/web/actions/runs/1',
      staleSince: null,
    },
  ],
};

async function serve(page: Page, mode: Mode) {
  const state = { mode };
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/v1/main-branches', (route: Route) => {
    if (state.mode === 'abort') return route.abort();
    if (state.mode === 'http500')
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"boom"}',
      });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(GOOD),
    });
  });
  return state;
}

const banner = (page: Page) => page.locator('.error-banner');

test.describe('Branches when the main-branches read fails (#3272)', () => {
  test('an HTTP 500 shows the shared banner, and Retry recovers', async ({
    page,
  }) => {
    const state = await serve(page, 'http500');
    await page.goto('/');

    await expect(banner(page)).toContainText(
      'The backend answered with an error (500).',
    );
    await expect(banner(page)).toHaveAttribute('role', 'alert');
    await expect(page.locator('.mb-note')).toHaveCount(0);

    state.mode = 'ok';
    await banner(page).getByRole('button', { name: 'Retry' }).click();
    await expect(banner(page)).toHaveCount(0);
    await expect(page.getByTestId('main-branch-row')).toHaveCount(1);
  });

  test('a network failure shows the could-not-reach wording, and Retry recovers', async ({
    page,
  }) => {
    const state = await serve(page, 'abort');
    await page.goto('/');

    await expect(banner(page)).toContainText('Could not reach the backend: ');
    await expect(banner(page)).not.toContainText('answered with an error');

    state.mode = 'ok';
    await banner(page).getByRole('button', { name: 'Retry' }).click();
    await expect(banner(page)).toHaveCount(0);
    await expect(page.getByTestId('main-branch-row')).toHaveCount(1);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the banner has no axe violations in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await serve(page, 'http500');
      await page.goto('/');
      await expect(banner(page)).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
