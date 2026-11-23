import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';
import { setTheme } from './theme-helper';

// The clear button and Escape from the pull request list's title box, on the
// Insights title box and the Main branches search box. Each empties only its
// own box and keeps focus there (#4144, after #4077).
// https://github.com/alrayyes/forge-dashboard/issues/4144

function pr(number: number, forge: 'github' | 'forgejo') {
  return {
    forge,
    repo: forge === 'github' ? 'acme/app' : 'acme/tool',
    number,
    title: `Change ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'sam',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    closesIssues: [],
    refsIssues: [],
    mentionsIssues: [],
  };
}

function branch(fullName: string, forge: 'github' | 'forgejo') {
  return {
    forge,
    fullName,
    url: `https://example.com/${fullName}`,
    branch: 'main',
    status: 'passed',
    commit: {
      sha: 'd98f3c2',
      subject: `fix: change in ${fullName}`,
      author: 'sre-dev',
      committedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
    failingJobs: [],
    finishedAt: null,
    durationSeconds: null,
    runUrl: `https://example.com/${fullName}/actions/runs/1`,
    checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
    latestRelease: null,
    staleSince: null,
  };
}

const BRANCHES = [
  branch('acme/alpha', 'github'),
  branch('acme/beta', 'github'),
  branch('infra/gamma', 'forgejo'),
];

async function openInsights(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github'), forgeHealth('forgejo')],
        pullRequests: [
          pr(1, 'github'),
          pr(2, 'github'),
          pr(3, 'forgejo'),
          pr(4, 'forgejo'),
        ],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/insights.html');
  await expect(page.locator('input[data-col="title"]')).toBeVisible();
}

async function openBranches(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 0,
          passed: BRANCHES.length,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: BRANCHES.length,
        },
        branches: BRANCHES,
      }),
    }),
  );
  await page.goto('/');
  await expect(page.getByTestId('main-branch-row')).toHaveCount(
    BRANCHES.length,
  );
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

const BOXES = [
  {
    name: 'Insights title box',
    open: openInsights,
    box: (page: Page) => page.locator('input[data-col="title"]'),
    button: (page: Page) =>
      page.getByRole('button', { name: 'Clear title filter' }),
    text: 'Change 3',
    // A second control that the clear must leave alone.
    other: async (page: Page) => {
      // The Forge group is drawn once the snapshot shows two forges (#4273).
      await expect(
        page.getByRole('group', { name: 'Filter by forge' }),
      ).toBeVisible();
      await page.locator('input[data-col="forge"][value="forgejo"]').check({
        force: true,
      });
    },
    otherKept: async (page: Page) => {
      await expect(
        page.locator('input[data-col="forge"][value="forgejo"]'),
      ).toBeChecked();
    },
  },
  {
    name: 'Main branches search box',
    open: openBranches,
    box: (page: Page) => page.locator('.mb-search'),
    button: (page: Page) => page.getByRole('button', { name: 'Clear search' }),
    text: 'gamma',
    other: async (page: Page) => {
      await page.getByRole('button', { name: /^Forgejo \d+$/ }).click();
    },
    otherKept: async (page: Page) => {
      // The forge pick survives: only the Forgejo row is listed.
      await expect(page.getByTestId('main-branch-row')).toHaveCount(1);
    },
  },
] as const;

const VIEWPORTS = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

for (const b of BOXES) {
  for (const vp of VIEWPORTS) {
    test.describe(`${b.name} clear at ${vp.width}px (#4144)`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
      });

      test('no clear button while the box is empty, one with text', async ({
        page,
      }) => {
        await b.open(page);
        await expect(b.button(page)).toHaveCount(0);
        await b.box(page).fill(b.text);
        await expect(b.button(page)).toBeVisible();
        await b.box(page).fill('');
        await expect(b.button(page)).toHaveCount(0);
      });

      test('the button empties the box and keeps focus there', async ({
        page,
      }) => {
        await b.open(page);
        // The other control is set first: a title that matches one forge
        // leaves the Forge filter nothing to offer (#4273).
        await b.other(page);
        await b.box(page).fill(b.text);
        await b.button(page).click();
        await expect(b.box(page)).toHaveValue('');
        await expect(b.box(page)).toBeFocused();
        await expect(b.button(page)).toHaveCount(0);
        await b.otherKept(page);
      });

      test('Escape empties the box and keeps focus; empty, it is left alone', async ({
        page,
      }) => {
        await b.open(page);
        await b.box(page).fill(b.text);
        await b.box(page).press('Escape');
        await expect(b.box(page)).toHaveValue('');
        await expect(b.box(page)).toBeFocused();
        // A synthetic Escape is ignored by a type=search box's own clearing,
        // so this only passes when the page's wiring handles it.
        const press = (el: HTMLElement) => {
          const e = new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          });
          el.dispatchEvent(e);
          return e.defaultPrevented;
        };
        await b.box(page).fill(b.text);
        expect(await b.box(page).evaluate(press)).toBe(true);
        await expect(b.box(page)).toHaveValue('');
        expect(await b.box(page).evaluate(press)).toBe(false);
      });

      if (vp.width < 400) {
        test('the button is a 44px target inside the box', async ({ page }) => {
          await b.open(page);
          await b.box(page).fill(b.text);
          await expect(b.button(page)).toBeVisible();
          await expect
            .poll(async () => (await b.button(page).boundingBox())?.height)
            .toBeGreaterThanOrEqual(44);
          await expect
            .poll(async () => (await b.button(page).boundingBox())?.width)
            .toBeGreaterThanOrEqual(44);
          await expect
            .poll(async () => {
              const k = await b.button(page).boundingBox();
              const s = await b.box(page).boundingBox();
              return (
                !!k && !!s && k.x >= s.x && k.x + k.width <= s.x + s.width + 0.5
              );
            })
            .toBe(true);
        });
      }
    });
  }

  test(`${b.name}: axe is clean in dark with and without text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await b.open(page);
    await setTheme(page, 'dark');
    await page.reload();
    await expect(b.box(page)).toBeVisible();
    expect((await axe(page)).violations).toEqual([]);
    await b.box(page).fill(b.text);
    await expect(b.button(page)).toBeVisible();
    expect((await axe(page)).violations).toEqual([]);
    await b.button(page).focus();
    expect((await axe(page)).violations).toEqual([]);
  });
}

// The Branches box is type=search, which Blink and WebKit give a cancel button
// of their own. The rule that hides it has no computed-style probe, so compare
// pixels: with the rule neutralised the native button is drawn and the box
// looks different (#4144).
test('Main branches search box: the native cancel button stays hidden', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openBranches(page);
  const box = page.locator('.mb-search');
  await box.fill('gamma');
  await page.addStyleTag({
    content: '.search-clear { visibility: hidden !important; }',
  });
  await box.hover();
  const hidden = await box.screenshot();
  await page.addStyleTag({
    content:
      '.search-wrap input[type="search"]::-webkit-search-cancel-button { appearance: auto !important; display: block !important; }',
  });
  const shown = await box.screenshot();
  expect(hidden.equals(shown)).toBe(false);
});
