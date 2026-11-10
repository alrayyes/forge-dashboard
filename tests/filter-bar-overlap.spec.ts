import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// A long repository name in the Repository filter stays inside its own box:
// the button ends in an ellipsis and never runs under the control beside it.
// https://github.com/alrayyes/forge-dashboard/issues/3370

const LONG = 'alrayyes/dotfiles-with-a-very-long-repository-name (Forgejo)';

const item = (number: number, repo: string) => ({
  forge: 'github',
  repo,
  number,
  title: `Item ${number}`,
  url: `https://example.com/${number}`,
  author: 'ryan',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'mergeable',
});

async function open(page: Page, path: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
        pullRequests: [item(1, LONG), item(2, 'alrayyes/app')],
        issues: [item(1, LONG), item(2, 'alrayyes/app')],
        openIssueCount: 2,
        navCounts: navCountsFor([], 0),
        firstRefreshDone: true,
      }),
    }),
  );
  await page.goto(path);
  await page.locator('#shared-repo-filter-button').click();
  await page
    .locator('#shared-repo-filter-panel label', { hasText: 'dotfiles' })
    .locator('input')
    .check();
  await page.keyboard.press('Escape');
}

// Every pair of visible controls in the bar whose drawn boxes share area.
async function overlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const boxes = [
      ...document.querySelectorAll<HTMLElement>(
        '.filter-bar #filter-controls > *',
      ),
    ]
      .map((el) => ({
        name: el.id || el.getAttribute('aria-label') || el.className,
        // The drawn control, not the box that is meant to hold it.
        r: (el.querySelector('.col-filter') ?? el).getBoundingClientRect(),
      }))
      .filter(({ r }) => r.width > 0 && r.height > 0);
    const out: string[] = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r;
        const b = boxes[j].r;
        if (
          a.left < b.right - 0.5 &&
          b.left < a.right - 0.5 &&
          a.top < b.bottom - 0.5 &&
          b.top < a.bottom - 0.5
        )
          out.push(`${boxes[i].name} overlaps ${boxes[j].name}`);
      }
    return out;
  });
}

for (const [name, path] of [
  ['issues', '/issues.html'],
  ['pull requests', '/pull-requests.html'],
] as const) {
  for (const width of [820, 1280, 1440, 1950]) {
    test(`${name}: a long repository name overlaps no neighbour at ${width}px (3370)`, async ({
      page,
    }) => {
      await open(page, path, width);
      const button = page.locator('#shared-repo-filter-button');
      await expect(button).toContainText('dotfiles-with-a-very-long');
      expect(await overlaps(page)).toEqual([]);
      const [button_, host] = await Promise.all([
        button.boundingBox(),
        page.locator('#shared-repo-filter').boundingBox(),
      ]);
      expect(button_?.width ?? 0).toBeLessThanOrEqual((host?.width ?? 0) + 0.5);
      await expect(button).toHaveCSS('text-overflow', 'ellipsis');
    });
  }
}
