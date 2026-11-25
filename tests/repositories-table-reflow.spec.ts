import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Repositories table never scrolls the page sideways, including at 768px
// with 175% text and five forges.
// https://github.com/alrayyes/forge-dashboard/issues/4886

const repo = (forge: string, name: string) => ({
  forge,
  fullName: `alrayyes/${name}`,
  hasWebhook: true,
  canManageWebhooks: true,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
  rebaseBots: false,
});

async function open(page: Page, width: number, scheme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: 800 });
  await page.emulateMedia({ colorScheme: scheme });
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
        repos: [
          repo('github', 'app'),
          repo('forgejo', 'wiki'),
          repo('gitlab', 'tools'),
          repo('gitea', 'docs'),
          repo('gogs', 'site'),
        ],
      }),
    }),
  );
  await page.goto('/settings.html#repositories');
  await page.locator('#repositories-rows tr').first().waitFor();
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [320, 390, 768, 1280]) {
    for (const zoom of [100, 175]) {
      test(`${width}px, ${zoom}% text, ${scheme}: the page does not scroll sideways, axe clean`, async ({
        page,
      }) => {
        await open(page, width, scheme);
        if (zoom !== 100) {
          await page.addStyleTag({
            content: `html { font-size: ${zoom}% !important; }`,
          });
        }
        const widths = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        expect(widths.scroll).toBeLessThanOrEqual(widths.client);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
}
