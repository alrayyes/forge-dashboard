import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// A pill that has a pipeline opens it: a tap on a phone, a click, Enter and
// Space, on whichever segment or part of the pill lands. A tap on a count
// used to show its tooltip and swallow the click.
// https://github.com/alrayyes/forge-dashboard/issues/4753

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.test/alrayyes/app/pull/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'blocked',
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

async function serve(page: Page, pullRequests: unknown[]) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests,
        issues: [],
        openIssueCount: 0,
        navCounts: navCountsFor(pullRequests, 0),
      }),
    }),
  );
}

const dialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Pipeline checks' });

// Every pill state a row can show, one row each.
const STATES: [string, Record<string, unknown>][] = [
  ['Failed', { ci: 'failure', checks: { passed: 7, running: 1, failed: 3 } }],
  ['Passed', { ci: 'success', checks: { passed: 5 } }],
  ['Running', { ci: 'pending', checks: { running: 3 } }],
  ['Cancelled', { ci: 'cancelled', checks: { passed: 4, cancelled: 9 } }],
];

const PAGES: [string, string, Record<string, unknown>][] = [
  ['pull requests', '/pull-requests.html', {}],
  [
    'releases',
    '/releases.html',
    {
      kind: 'release',
      author: 'release-please[bot]',
      title: 'chore(main): release 1.0.0',
    },
  ],
  [
    'bots',
    '/bots.html',
    { kind: 'dependency', author: 'dependabot', title: 'Bump foo from 1 to 2' },
  ],
];

test.describe('on a phone, tapping a CI pill opens its checks (#4753)', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  for (const [where, path, extra] of PAGES) {
    for (const [name, state] of STATES) {
      test(`${name} pill on the ${where} page: every part opens the dialog`, async ({
        page,
      }) => {
        await serve(page, [pr(1, { ...extra, ...state })]);
        await page.goto(path);
        const pill = page.locator('#pr-rows .row .ci-pill').first();
        await expect(pill).toBeVisible();

        // A poll redraws a pill's parts in place, and button.ci-pill > * has
        // pointer-events: none, so a tap needs `force`, which also turns off
        // Playwright's wait for the node to be actionable. A tap on a node
        // the redraw just replaced fails with 'Element is not visible'. So
        // read where every visible part sits once, in one call, and tap those
        // points: the redraw keeps the layout, and the press lands on the
        // button, as a thumb's does.
        const partsLocator = pill.locator('.ci-word:visible, .ci-seg:visible');
        await expect(partsLocator.first()).toBeVisible();
        const points = await partsLocator.evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }),
        );
        expect(points.length).toBeGreaterThan(0);
        for (const point of points) {
          await page.touchscreen.tap(point.x, point.y);
          await expect(dialog(page)).toBeVisible();
          await expect(page.locator('.ci-pill-tip')).toBeHidden();
          await page.keyboard.press('Escape');
          await expect(dialog(page)).toBeHidden();
          await expect(pill).toBeFocused();
        }
      });
    }
  }

  test('axe is clean with the dialog closed and open', async ({ page }) => {
    await serve(page, [pr(1, STATES[0][1])]);
    await page.goto('/pull-requests.html');
    const pill = page.locator('#pr-rows .row .ci-pill').first();
    await pill.locator('.ci-seg-failed').tap({ force: true });
    await expect(dialog(page)).toBeVisible();
    const open = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(open.violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    const closed = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(closed.violations).toEqual([]);
  });
});

test.describe('keyboard and mouse open it too (#4753)', () => {
  for (const key of ['Enter', 'Space']) {
    test(`${key} on a focused pill opens the dialog and Escape returns focus`, async ({
      page,
    }) => {
      await serve(page, [pr(1, STATES[0][1])]);
      await page.goto('/pull-requests.html');
      const pill = page.locator('#pr-rows .row .ci-pill').first();
      await pill.focus();
      await page.keyboard.press(key === 'Space' ? ' ' : key);
      await expect(dialog(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();
      await expect(pill).toBeFocused();
    });
  }

  test('a mouse click on a segment opens the dialog', async ({ page }) => {
    await serve(page, [pr(1, STATES[0][1])]);
    await page.goto('/pull-requests.html');
    await page
      .locator('#pr-rows .row .ci-pill .ci-seg-failed')
      .click({ force: true });
    await expect(dialog(page)).toBeVisible();
  });
});
