import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1455: filter pull requests by CI passing and running (quick pills next to
// Failing CI) and by whether auto-merge is on (a segment that combines with a
// pill). A pull request whose forge doesn't report auto-merge is in neither On
// nor Off.
// https://github.com/alrayyes/forge-dashboard/issues/1455

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `auto-merge-filter-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'Auto Merge Filter',
  );
}

function pr(
  number: number,
  title: string,
  ci: string,
  autoMergeEnabled?: boolean,
  overrides: Record<string, unknown> = {},
) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci,
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
    ...(autoMergeEnabled === undefined ? {} : { autoMergeEnabled }),
    ...overrides,
  };
}

// passing, auto-merge off / passing, on / running, off / failing, unknown.
const PRS = [
  pr(1, 'Passing off', 'success', false),
  pr(2, 'Passing on', 'success', true),
  pr(3, 'Running off', 'pending', false),
  pr(4, 'Failing unknown', 'failure'),
];

let current: unknown[] = PRS;

async function serve(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: current,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

async function open(page: Page, prs: unknown[] = PRS) {
  current = prs;
  await serve(page);
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(prs.length);
}

const pill = (page: Page, name: string) =>
  page
    .getByRole('group', { name: 'Quick filters' })
    .getByRole('button', { name, exact: true });
const am = (page: Page, value: 'any' | 'on' | 'off') =>
  page.locator(`.filter-bar > .am-group [data-am="${value}"]`);
const titles = (page: Page) => page.locator('#pr-rows > .row .title-text');

test.describe('CI pills and the auto-merge filter (#1455)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('Passing CI and Running CI keep only the pull requests in that CI state', async ({
    page,
  }) => {
    await open(page);

    await pill(page, 'Passing CI').click();
    await expect(titles(page)).toHaveCount(2);
    await expect(page.locator('#pr-rows')).not.toContainText('Running off');

    await pill(page, 'Running CI').click();
    await expect(titles(page)).toHaveCount(1);
    await expect(titles(page).first()).toContainText('Running off');
    await expect(pill(page, 'Passing CI')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('Auto-merge On and Off keep only what the forge says; an unknown one is in neither', async ({
    page,
  }) => {
    await open(page);

    await am(page, 'on').click();
    await expect(titles(page)).toHaveCount(1);
    await expect(titles(page).first()).toContainText('Passing on');

    await am(page, 'off').click();
    await expect(titles(page)).toHaveCount(2);
    await expect(page.locator('#pr-rows')).not.toContainText('Failing unknown');
    await expect(am(page, 'off')).toHaveAttribute('aria-pressed', 'true');

    await am(page, 'any').click();
    await expect(titles(page)).toHaveCount(4);
  });

  test('a CI pill and Auto-merge Off combine', async ({ page }) => {
    await open(page);

    await pill(page, 'Passing CI').click();
    await am(page, 'off').click();

    await expect(titles(page)).toHaveCount(1);
    await expect(titles(page).first()).toContainText('Passing off');
    await expect(pill(page, 'Passing CI')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('a pill or an option nothing matches is not offered, and the segment goes when neither is', async ({
    page,
  }) => {
    await open(page, [pr(1, 'Only passing', 'success', true)]);

    await expect(pill(page, 'Passing CI')).toBeVisible();
    await expect(pill(page, 'Running CI')).toBeHidden();
    await expect(pill(page, 'Failing CI')).toBeHidden();
    await expect(am(page, 'on')).toBeVisible();
    await expect(am(page, 'off')).toBeHidden();

    current = [pr(2, 'Unknown', 'success')];
    await page.reload();
    await expect(page.locator('.filter-bar > .am-group')).toBeHidden();
  });

  test('the choice survives a reload, stays offered when nothing matches it, and Clear filters resets it', async ({
    page,
  }) => {
    await open(page);
    const saved = page.waitForResponse(
      (r) =>
        r.url().includes('/api/settings/filter-state') &&
        r.request().method() !== 'GET',
    );
    await am(page, 'on').click();
    await saved;

    current = [pr(1, 'Only off', 'success', false)];
    await page.reload();

    // Nothing is on any more, but the active choice stays so it can be cleared.
    await expect(am(page, 'on')).toHaveAttribute('aria-pressed', 'true');
    await expect(titles(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(am(page, 'any')).toHaveAttribute('aria-pressed', 'true');
    await expect(titles(page)).toHaveCount(1);
  });

  test('on a 360px phone the segment is in the Filters sheet and the CI pills stay in the row', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page);

    await expect(pill(page, 'Passing CI')).toBeVisible();
    await expect(page.locator('.filter-bar > .am-group')).toBeHidden();

    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.locator('dialog#filter-sheet');
    await sheet.locator('.am-group [data-am="off"]').click();

    await page.keyboard.press('Escape');
    await expect(titles(page)).toHaveCount(2);
  });

  test('on a 360px phone the sheet draws no segment when nothing is on or off, and its buttons are 44px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page);
    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.locator('dialog#filter-sheet');

    for (const value of ['any', 'on', 'off']) {
      const box = await sheet
        .locator(`.am-group [data-am="${value}"]`)
        .boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    await page.keyboard.press('Escape');
    current = [pr(1, 'Unknown', 'success')];
    await page.reload();
    await page.getByRole('button', { name: /^Filters/ }).click();
    await expect(sheet.locator('.am-group')).toBeHidden();
  });

  test('a saved choice that is not on or off reads as Any', async ({
    page,
    request,
  }) => {
    await open(page);
    const saved = page.waitForResponse(
      (r) =>
        r.url().includes('/api/settings/filter-state') &&
        r.request().method() !== 'GET',
    );
    await am(page, 'on').click();
    await saved;
    await page.evaluate(async () => {
      const got = await (
        await fetch('/api/settings/filter-state', {
          headers: { Accept: 'application/json' },
        })
      ).json();
      got.pr.autoMerge = 'bogus';
      document.cookie = 'forge-board-filters=; Max-Age=0; path=/';
      await fetch('/api/settings/filter-state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(got),
      });
    });
    // The saved value arrives after the first paint, so wait for it and a
    // frame to apply it before asserting that nothing shows.
    const restored = page.waitForResponse(
      (r) =>
        r.url().includes('/api/settings/filter-state') &&
        r.request().method() === 'GET',
    );
    await page.reload();
    await restored;
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => done(null))),
    );

    await expect(am(page, 'any')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Auto-merge bogus')).toHaveCount(0);
    await expect(titles(page)).toHaveCount(PRS.length);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe-core violations in the ${scheme} theme, with a CI pill and the segment active`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      await pill(page, 'Passing CI').click();
      await am(page, 'off').click();
      await expect(titles(page)).toHaveCount(1);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
