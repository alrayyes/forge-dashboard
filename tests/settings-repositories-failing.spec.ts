import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A repo whose fetch keeps failing says so on its row in Settings,
// Repositories, with the time it began, so a long outage is not silent.
// https://github.com/alrayyes/forge-dashboard/issues/4803

const HOURS_AGO = (n: number) =>
  new Date(Date.now() - n * 3_600_000).toISOString();

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  forge: 'github',
  fullName: `alrayyes/${name}`,
  hasWebhook: true,
  canManageWebhooks: true,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
  rebaseBots: false,
  ...extra,
});

async function open(page: Page, repos: Record<string, unknown>[]) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos,
      }),
    }),
  );
  await page.goto('/settings.html#repositories');
}

test.describe('failing repo badge in Settings, Repositories', () => {
  test('a failing repo shows the badge, a healthy one does not', async ({
    page,
  }) => {
    await open(page, [
      repo('broken', { failingSince: HOURS_AGO(3) }),
      repo('fine'),
    ]);

    const broken = page.locator('tr', { hasText: 'alrayyes/broken' });
    await expect(broken.locator('.failing-badge')).toContainText(
      'Failing since',
    );
    await expect(broken.locator('.failing-note')).toBeVisible();
    await expect(
      page
        .locator('tr', { hasText: 'alrayyes/fine' })
        .locator('.failing-badge'),
    ).toHaveCount(0);
  });

  test('past the cutoff the badge reads Still failing since', async ({
    page,
  }) => {
    await open(page, [
      repo('old', { failingSince: HOURS_AGO(30), failingForGood: true }),
    ]);

    const old = page.locator('tr', { hasText: 'alrayyes/old' });
    await expect(old.locator('.failing-badge')).toContainText(
      'Still failing since',
    );
    await expect(old.locator('.failing-note')).toContainText(
      "Retrying hasn't helped",
    );
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390]) {
      test(`axe and layout are clean, ${scheme} ${width}px`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 800 });
        await open(page, [
          repo('broken', { failingSince: HOURS_AGO(3) }),
          repo('old-and-a-very-long-repository-name', {
            failingSince: HOURS_AGO(30),
            failingForGood: true,
          }),
        ]);

        await expect(page.locator('.failing-badge')).toHaveCount(2);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);

        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth,
            ),
          )
          .toBe(false);
      });
    }
  }
});
