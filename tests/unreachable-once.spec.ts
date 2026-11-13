import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3719: a forge that is down is said once, in one banner. No chip repeats it,
// both forges down share one banner, and the healthy forge's pill is untouched.

const down = (forge: string) => ({
  forge,
  reachable: false,
  repoCount: 1,
  errorKind: 'unreachable',
  error: 'dial tcp: i/o timeout',
  staleSince: new Date(Date.now() - 3 * 3600_000).toISOString(),
});
const up = (forge: string) => ({ forge, reachable: true, repoCount: 1 });

const pr = (n: number, forge = 'github') => ({
  forge,
  repo: 'alrayyes/demo',
  number: n,
  title: `Pull request ${n}`,
  url: `https://example.com/${n}`,
  author: 'claude',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
});

async function open(page: Page, forges: unknown[]) {
  await page.route('**/api/v1/dashboard*', (route: Route) => {
    if (route.request().url().includes('/stream')) return route.abort();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges,
        pullRequests: [pr(1), pr(2, 'forgejo')],
        issues: [],
      }),
    });
  });
  await page.goto('/pull-requests.html');
}

const cases = [
  {
    name: 'GitHub alone',
    forges: [down('github'), up('forgejo')],
    text: /^GitHub is unreachable\. Showing data from .+, 3h ago\. Retrying automatically\.\s*GitHub status\s*Retry$/,
    link: true,
  },
  {
    name: 'Forgejo alone',
    forges: [up('github'), down('forgejo')],
    text: /^Forgejo is unreachable\. Showing data from .+, 3h ago\. Retrying automatically\.\s*Retry$/,
    link: false,
  },
  {
    name: 'both',
    forges: [down('github'), down('forgejo')],
    text: /^GitHub and Forgejo are unreachable\. Showing data from .+, 3h ago\. Retrying automatically\.\s*GitHub status\s*Retry$/,
    link: true,
  },
];

for (const c of cases) {
  for (const width of [360, 390, 1280]) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${c.name} at ${width}px, ${scheme}: one banner, no chip, axe clean`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        await open(page, c.forges);

        const banner = page.locator('#unreachable-banner');
        await expect(page.locator('.unreachable-banner')).toHaveCount(1);
        await expect(banner).toHaveAttribute('role', 'status');
        await expect(banner).toHaveText(c.text);
        await expect(banner.getByRole('link')).toHaveCount(c.link ? 1 : 0);
        await expect(banner.getByRole('button', { name: 'Retry' })).toHaveText(
          'Retry',
        );

        // Nothing else says it: no chip for the down forge, no second line.
        const health = page.locator('#forge-health');
        await expect(health).not.toContainText(/unreachable|Showing data/);
        await expect(page.getByText('Retrying automatically')).toHaveCount(1);
        // The healthy forge draws no chip either (#3681).
        await expect(page.locator('#forge-health .forge-health')).toHaveCount(
          0,
        );

        const min = width <= 480 ? 44 : 24;
        for (const el of await banner.locator('a, button').all()) {
          const box = await el.boundingBox();
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(min);
          expect(box?.width ?? 0).toBeGreaterThanOrEqual(min);
        }
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
}
