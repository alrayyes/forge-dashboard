import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
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
async function boxes(pills: Locator) {
  return pills.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10);
    }),
  );
}

async function seedPulls(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        // Two repos and authors, so those filters stay in the bar. One pull
        // request fails and one passes, so the Failing CI pill changes the
        // list and the quick pills are offered (#3669).
        pullRequests: [
          ['acme/app', 'someone'],
          ['acme/lib', 'other'],
        ].map(([repo, author], i) => ({
          forge: 'github',
          repo,
          number: i + 1,
          title: 'A pull request',
          url: `https://example.com/${i + 1}`,
          author,
          draft: false,
          ci: i === 0 ? 'failure' : 'success',
          mergeStatus: 'blocked',
          labels: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
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
        forges: [forgeHealth('github')],
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
    pill: '.filter-pill',
    seed: seedPulls,
  },
  {
    name: 'Branches pills',
    path: '/',
    pill: '.filter-pill',
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
      // On a phone the quick pills live in the Filters sheet (#3734).
      if (width === 390 && c.name === 'quick pills')
        await page.getByRole('button', { name: /^Filters/ }).click();
      const pills = page.locator(`${c.pill}:visible`);
      await expect(pills.first()).toBeVisible();
      const pressed = pills.and(page.locator('[aria-pressed="true"]')).first();
      const open = pills.and(page.locator('[aria-pressed="false"]')).first();
      await expect(pressed).toBeVisible();
      await expect(open).toBeVisible();
      await expect
        .poll(async () => (await shape(pressed)) !== (await shape(open)))
        .toBe(true);

      // Focused, a pressed pill still differs from an open one, and the
      // ring keeps its offset.
      await page.keyboard.press('Shift');
      await pressed.focus();
      await expect
        .poll(async () => {
          await pressed.focus();
          const focusedPressed = await shape(pressed);
          await open.focus();
          return focusedPressed !== (await shape(open));
        })
        .toBe(true);
      await pressed.focus();
      await expect(pressed).toHaveCSS('outline-offset', '2px');
      await page.locator('body').click({ position: { x: 1, y: 1 } });

      // The mark takes no room: no pill moves or resizes, none overlaps.
      const withMark = await boxes(pills);
      await page.emulateMedia({ forcedColors: 'none' });
      await expect.poll(() => boxes(pills)).toEqual(withMark);
      for (const [i, a] of withMark.entries()) {
        for (const b of withMark.slice(i + 1)) {
          const apart =
            a[0] + a[2] <= b[0] + 0.5 ||
            b[0] + b[2] <= a[0] + 0.5 ||
            a[1] + a[3] <= b[1] + 0.5 ||
            b[1] + b[3] <= a[1] + 0.5;
          expect(apart).toBe(true);
        }
      }
    });
  }
}

// A pressed CI pill sets its own border-color from the state's tone, which
// forced colours would remap to the UA's colour rather than Highlight. The 3px
// width alone told it apart; the colour has to match too, on the Branches
// Status group and on the pull request page's CI filter.
const CI_CASES = [
  {
    name: 'Branches Status',
    path: '/',
    seed: seedBranches,
    pill: '.filter-pill.ci-filter-pill',
  },
  {
    name: 'pull request CI filter',
    path: '/pull-requests.html',
    seed: seedPulls,
    pill: '.quick-pill.ci-filter-pill',
  },
];

for (const c of CI_CASES) {
  test(`a pressed ${c.name} pill draws its border in Highlight under forced colors`, async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await c.seed(page);
    await page.goto(c.path);
    const failing = page.locator(c.pill, { hasText: 'Failing' }).first();
    await failing.click();
    await expect(failing).toHaveAttribute('aria-pressed', 'true');
    const [border, highlight] = await failing.evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'Highlight';
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(el).borderTopColor, colour];
    });
    expect(border).toBe(highlight);
  });
}
