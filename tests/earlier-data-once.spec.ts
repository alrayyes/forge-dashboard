import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #5127: that a forge isn't answering is said once above the list. An affected
// row carries a short "Earlier data" marker, and still says why to a screen
// reader.

const WHY =
  "Showing data. The forge isn't answering yet, so this may be an earlier answer, and no action can run until it does.";
const STALE = { code: 'forge_unreachable', message: WHY };
const HELD = {
  code: 'held',
  message:
    'Runs are held for approval. Approve the workflow runs on the forge first.',
};

const ago = () => new Date(Date.now() - 10 * 60_000).toISOString();
const starting = () =>
  forgeHealth('github', {
    reachable: false,
    starting: true,
    staleSince: ago(),
  });
const outage = () =>
  forgeHealth('github', {
    reachable: false,
    errorKind: 'unreachable',
    error: 'timeout',
    staleSince: ago(),
  });
const up = () => forgeHealth('github');

const pr = (n: number, over: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: 'alrayyes/demo',
  number: n,
  title: `Pull request ${n}`,
  url: `https://example.com/${n}`,
  author: 'claude',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date(Date.now() - n * 1000).toISOString(),
  mergeStatus: 'blocked',
  behind: false,
  kind: 'regular',
  ...over,
});
const stale = (n: number, over: Record<string, unknown> = {}) =>
  pr(n, {
    status: STALE,
    allowedActions: [{ action: 'merge', blocked: STALE }],
    ...over,
  });
const elsewhere = pr(3, { forge: 'forgejo', mergeStatus: 'mergeable' });

type State = { forges: unknown[]; prs: unknown[] };

async function open(page: Page, state: State, path = '/pull-requests.html') {
  await page.route(
    /\/api\/v1\/dashboard(\/refresh|\/stream)?(\?.*)?$/,
    (route: Route) => {
      if (route.request().url().includes('/stream')) return route.abort();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: state.forges,
          pullRequests: state.prs,
          issues: [],
          repos: [],
          hiddenDrafts: 0,
        }),
      });
    },
  );
  await page.goto(path);
  await expect(page.locator('#pr-rows .row')).toHaveCount(state.prs.length);
}

const row = (page: Page, n: number) =>
  page.locator('#pr-rows .row', { hasText: `Pull request ${n}` });
const title = (page: Page, n: number) => row(page, n).locator('button.title');

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

// The refresh is sent from script, so nothing but the redraw could move focus.
const refresh = (page: Page) =>
  page.evaluate(() => document.getElementById('force-refresh-button')?.click());

for (const width of [390, 1280]) {
  test(`${width}px: a starting forge is said once above the list, and its rows are marked`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, {
      forges: [starting(), forgeHealth('forgejo')],
      prs: [stale(1), stale(2), elsewhere],
    });

    const notice = page.locator('#earlier-data-notice');
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(notice).toHaveText(
      "GitHub isn't answering yet, so rows marked Earlier data may be an earlier answer from 10m ago, and no action can run on them until it does.",
    );
    await expect(page.locator('#unreachable-banner')).toHaveCount(0);

    for (const n of [1, 2]) {
      await expect(row(page, n).locator('.earlier-data')).toContainText(
        'Earlier data',
      );
      await expect(row(page, n).locator('.status-area')).toHaveCount(0);
      await expect(title(page, n)).toHaveAccessibleDescription(WHY);
    }
    await expect(row(page, 3).locator('.earlier-data')).toHaveCount(0);
    await expectNoOverflow(page);
    await expectAxeClean(page);
  });

  test(`${width}px: an unreachable forge's banner carries the sentence, with no second notice`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, { forges: [outage()], prs: [stale(1), stale(2)] });

    const banner = page.locator('#unreachable-banner');
    await expect(banner).toContainText('GitHub is unreachable.');
    await expect(banner).toContainText(
      'Rows marked Earlier data may be an earlier answer, and no action can run on them while this lasts.',
    );
    await expect(page.locator('.unreachable-banner-earlier')).toHaveCount(1);
    await expect(page.locator('#earlier-data-notice')).toHaveCount(0);
    await expect(page.locator('#pr-rows .earlier-data')).toHaveCount(2);
    await expectNoOverflow(page);
    await expectAxeClean(page);
  });

  test(`${width}px: a bot row's locked actions are described by its marker`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const bot = stale(1, {
      kind: 'dependency',
      author: 'dependabot',
      allowedActions: [
        { action: 'merge', blocked: STALE },
        { action: 'dependabot_rebase', blocked: STALE },
      ],
    });
    // The second host of the kind still answers, so the buttons stay drawn.
    await open(page, { forges: [starting(), up()], prs: [bot] }, '/bots.html');

    await expect(row(page, 1).locator('.status-area')).toHaveCount(0);
    await expect(
      row(page, 1).getByRole('button', { name: /Dependabot: Rebase/ }),
    ).toHaveAccessibleDescription(WHY);
    await expect(page.locator('#earlier-data-notice')).toHaveCount(1);
    await expectAxeClean(page);
  });
}

test('a row-specific status stays on its row, unmarked', async ({ page }) => {
  await open(page, {
    forges: [starting()],
    prs: [stale(1), pr(2, { status: HELD })],
  });

  await expect(row(page, 2).locator('.status-area-message')).toHaveText(
    HELD.message,
  );
  await expect(row(page, 2).locator('.earlier-data')).toHaveCount(0);
});

test('an unconfirmed conflict says why, and leaves the earlier answer to the notice', async ({
  page,
}) => {
  await open(page, {
    forges: [starting()],
    prs: [stale(1, { mergeStatus: 'conflicting', conflictConfirmed: false })],
  });

  const reason = row(page, 1).locator('.merge-where');
  await expect(reason).toContainText('No merge or update has been refused');
  await expect(reason).not.toContainText("isn't answering");
});

test('the notice is not redrawn by the same news, and goes with the markers without moving focus', async ({
  page,
}) => {
  const state: State = { forges: [starting()], prs: [stale(1), stale(2)] };
  await open(page, state);
  const notice = page.locator('#earlier-data-notice');
  await expect(notice).toHaveCount(1);
  await notice.evaluate((el) => {
    el.dataset.seen = 'yes';
  });

  // Filtering redraws the rows with the same news.
  await page.locator('#title-filter').fill('Pull request 1');
  await expect(page.locator('#pr-rows .row')).toHaveCount(1);
  await expect(notice).toHaveAttribute('data-seen', 'yes');
  await page.locator('#title-filter').fill('');
  await expect(page.locator('#pr-rows .row')).toHaveCount(2);

  const navLink = page.getByRole('navigation').getByRole('link').first();
  await navLink.focus();
  state.forges = [up()];
  state.prs = [pr(1), pr(2)];
  await refresh(page);

  await expect(notice).toHaveCount(0);
  await expect(page.locator('#pr-rows .earlier-data')).toHaveCount(0);
  await expect(navLink).toBeFocused();
});
