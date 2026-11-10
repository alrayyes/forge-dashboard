import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// Forced-colors mode remaps colours, so a pressed filter pill can't rely on
// its accent fill. The mark has to be something forced colors keep: an
// outline, a border width or a weight. Compares computed non-colour style.
// https://github.com/alrayyes/forge-dashboard/issues/3377

async function shape(pill: Locator) {
  return pill.evaluate((el) => {
    const s = getComputedStyle(el);
    return [
      s.outlineStyle,
      s.outlineWidth,
      s.borderTopWidth,
      s.borderTopStyle,
      s.fontWeight,
      s.textDecorationLine,
    ].join('|');
  });
}

// The quick pills other than All stay hidden until the page has rows.
async function seedPulls(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [
          {
            forge: 'github',
            repo: 'acme/app',
            number: 1,
            title: 'A pull request',
            url: 'https://example.com/1',
            author: 'someone',
            draft: false,
            ci: 'failure',
            mergeStatus: 'blocked',
            labels: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

async function seedBranches(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [],
        repos: [{ forge: 'github', fullName: 'acme/a', hasWebhook: true }],
        firstRefreshDone: true,
      }),
    }),
  );
  const branch = (name: string, status: string) => ({
    forge: 'github',
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
    failingJobs: [],
    finishedAt: new Date().toISOString(),
    durationSeconds: 60,
    runUrl: `https://example.com/${name}/actions/runs/1`,
    staleSince: null,
  });
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 1,
          passed: 1,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: 2,
        },
        branches: [branch('acme/a', 'passed'), branch('acme/b', 'failed')],
      }),
    }),
  );
}

const CASES = [
  {
    name: 'quick pills',
    path: '/pull-requests.html',
    pill: '.quick-pill',
    seed: seedPulls,
  },
  {
    name: 'Branches pills',
    path: '/',
    pill: '.mb-pill',
    seed: seedBranches,
  },
];

for (const width of [390, 1280]) {
  for (const c of CASES) {
    test(`${c.name} at ${width}px: pressed differs from unpressed under forced colors`, async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: 'active' });
      await page.setViewportSize({ width, height: 800 });
      await c.seed(page);
      await page.goto(c.path);
      const pills = page.locator(`${c.pill}:visible`);
      await expect(pills.first()).toBeVisible();
      const pressed = pills.and(page.locator('[aria-pressed="true"]')).first();
      const open = pills.and(page.locator('[aria-pressed="false"]')).first();
      await expect(pressed).toBeVisible();
      await expect(open).toBeVisible();
      expect(await shape(pressed)).not.toBe(await shape(open));
    });
  }
}

test('a pressed pill keeps the focus ring offset under forced colors', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/pull-requests.html');
  const pressed = page.locator('.quick-pill[aria-pressed="true"]').first();
  await page.keyboard.press('Shift');
  await pressed.focus();
  await expect(pressed).toBeFocused();
  await expect(pressed).toHaveCSS('outline-style', 'solid');
  const offset = await pressed.evaluate(
    (el) => getComputedStyle(el).outlineOffset,
  );
  expect(offset).toBe('2px');
});
