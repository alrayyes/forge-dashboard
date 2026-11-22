import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The Main branches page draws its Status, Forge and Advisories groups with the
// one shared filter pill: 32px high, outlined, a visible group label and a
// count in every pill, and on a phone a 44px hit area around the 32px pill
// (#4279).
// https://github.com/alrayyes/forge-dashboard/issues/4279
// https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html

function branch(name: string, forge: string, status: string) {
  return {
    forge,
    fullName: name,
    url: `https://example.com/${name}`,
    branch: 'main',
    status,
    commit: {
      sha: 'd98f3c2',
      subject: 'fix: a change',
      author: 'dev',
      committedAt: new Date().toISOString(),
    },
    failingJobs: status === 'failed' ? ['lint'] : [],
    finishedAt: new Date().toISOString(),
    durationSeconds: 60,
    runUrl: `https://example.com/${name}/actions/runs/1`,
    staleSince: null,
  };
}

async function seed(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github'), forgeHealth('forgejo')],
        pullRequests: [],
        issues: [],
        repos: [{ forge: 'github', fullName: 'acme/a', hasWebhook: true }],
        firstRefreshDone: true,
      }),
    }),
  );
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {},
        branches: [
          branch('acme/a', 'github', 'passed'),
          branch('acme/b', 'github', 'failed'),
          branch('acme/c', 'forgejo', 'passed'),
        ],
      }),
    }),
  );
}

async function open(
  page: Page,
  width: number,
  scheme: 'light' | 'dark' = 'light',
) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 800 });
  await seed(page);
  await page.goto('/');
  await expect(page.locator('.filter-pill').first()).toBeVisible();
}

for (const width of [1280, 390, 320]) {
  test(`at ${width}px every pill is drawn 32px high with a count`, async ({
    page,
  }) => {
    await open(page, width);
    const pills = page.locator('.mb-bar .filter-pill');
    expect(await pills.count()).toBeGreaterThanOrEqual(6);
    const drawn = await pills.evaluateAll((ps) =>
      ps.map((p) => ({
        h: p.getBoundingClientRect().height,
        count: p.querySelector('.filter-pill-count')?.textContent ?? '',
        radius: getComputedStyle(p).borderTopLeftRadius,
        border: getComputedStyle(p).borderTopWidth,
      })),
    );
    for (const d of drawn) {
      expect(d.h).toBe(32);
      expect(d.count).toMatch(/^\d+$/);
      expect(d.border).toBe('1px');
    }
  });
}

test('each group has a visible label that names it', async ({ page }) => {
  await open(page, 1280);
  for (const name of ['Status', 'Forge']) {
    const group = page.getByRole('group', { name, exact: true });
    await expect(group).toBeVisible();
    await expect(group.locator('.filter-group-label')).toHaveText(name);
    await expect(group.locator('.filter-group-label')).toBeVisible();
  }
});

for (const width of [390, 320]) {
  test(`on a phone the hit area is 44px high around the 32px pill at ${width}px`, async ({
    page,
  }) => {
    await open(page, width);
    const pills = page.locator('.mb-bar .filter-pill');
    const total = await pills.count();
    for (let i = 0; i < total; i++) {
      const pill = pills.nth(i);
      await pill.evaluate((p) => p.scrollIntoView({ block: 'center' }));
      expect((await pill.boundingBox())?.height).toBe(32);
      const hits = await pill.evaluate((p) => {
        const r = p.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const at = (y: number) => document.elementFromPoint(x, y);
        const owns = (y: number) => {
          const e = at(y);
          return e === p || p.contains(e);
        };
        // The target runs 6px past the drawn edge: 5px out is the pill's, and
        // 7.5px out is not (a point at exactly 6px snaps to the neighbour).
        return [
          owns(r.top - 5),
          owns(r.bottom + 5),
          owns(r.top - 7.5),
          owns(r.bottom + 7.5),
        ];
      });
      expect(hits).toEqual([true, true, false, false]);
      // The room a tap has never reaches the pill in the next row.
      const gap = await pill.evaluate((p) => {
        const r = p.getBoundingClientRect();
        const below = [
          ...document.querySelectorAll('.mb-bar .filter-pill'),
        ].find((q) => q.getBoundingClientRect().top >= r.bottom - 1 && q !== p);
        return below ? below.getBoundingClientRect().top - r.bottom : 99;
      });
      expect(gap).toBeGreaterThanOrEqual(12);
    }
  });
}

test('on a desktop the hit area is the drawn pill', async ({ page }) => {
  await open(page, 1280);
  const pill = page.locator('.mb-bar .filter-pill').first();
  const hit = await pill.evaluate((p) => {
    const r = p.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top - 5) === p;
  });
  expect(hit).toBe(false);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the bar has no axe violations in ${scheme}`, async ({ page }) => {
    await open(page, 1280, scheme);
    const { violations } = await new AxeBuilder({ page })
      .include('.mb-bar')
      .analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });
}
