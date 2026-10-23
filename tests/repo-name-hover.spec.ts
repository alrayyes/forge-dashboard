import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A repo name cut with an ellipsis carries its whole owner/name as hover text
// on the pull request pages, as a pull request title does. Mocks
// /api/dashboard and its stream only.
// https://github.com/alrayyes/forge-dashboard/issues/2627

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const LONG = 'alrayyes/an-unusually-long-repository-name-that-gets-truncated';
const SHORT = 'alrayyes/dotfiles';

function makePR(number: number, repo: string) {
  return {
    forge: 'github',
    repo,
    number,
    title: `Change ${number}`,
    url: `https://example.com/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: ago(60),
    updatedAt: ago(5),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
  };
}

const snapshot = (pullRequests: unknown[]) => ({
  generatedAt: new Date().toISOString(),
  forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
  pullRequests,
  issues: [],
});

async function mockDashboard(page: Page, pullRequests: unknown[]) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __streams: EventSource[];
      EventSource: typeof EventSource;
    };
    w.__streams = [];
    const Real = w.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        w.__streams.push(this);
      }
    };
  });
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(pullRequests)),
    }),
  );
}

const repoName = (page: Page, n: number) =>
  page.locator('#pr-rows .row', { hasText: `#${n}` }).locator('.repo-name');

for (const [label, width] of [
  ['desktop', 1280],
  ['phone', 360],
] as const) {
  test.describe(`repo names on the pull request page at ${label} width`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await mockDashboard(page, [makePR(1, LONG), makePR(2, SHORT)]);
    });

    test('a cut repo name carries its full name as hover text', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      await expect(repoName(page, 1)).toBeVisible();
      const cut = await repoName(page, 1).evaluate(
        (el) => el.scrollWidth > el.clientWidth,
      );
      await expect(repoName(page, 1)).toHaveAttribute('title', LONG);
      // Record whether the name was cut at this width, for the ticket.
      test.info().annotations.push({ type: 'cut', description: String(cut) });
    });

    test('a name that fits carries none, as a short title does', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      await expect(repoName(page, 2)).toBeVisible();
      await expect(repoName(page, 2)).not.toHaveAttribute('title');
    });

    test('a live update that redraws the rows keeps the hover text', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      await expect(repoName(page, 1)).toHaveAttribute('title', LONG);
      const next = JSON.stringify(
        snapshot([makePR(1, LONG), makePR(2, SHORT), makePR(3, LONG)]),
      );
      await page.evaluate((data) => {
        const w = window as unknown as { __streams: EventSource[] };
        if (w.__streams.length === 0) throw new Error('no stream is open');
        for (const s of w.__streams)
          s.onmessage?.(new MessageEvent('message', { data }));
      }, next);
      await expect(repoName(page, 3)).toHaveAttribute('title', LONG);
      await expect(repoName(page, 1)).toHaveAttribute('title', LONG);
      await expect(repoName(page, 2)).not.toHaveAttribute('title');
    });

    test('the cut text is what the pointer hits, and a click on it still opens the dialog', async ({
      page,
    }) => {
      await page.route('**/api/pull-requests/details*', (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            description: null,
            comments: [],
            commentCount: 0,
            commentsTruncated: false,
            releaseNotes: null,
          }),
        }),
      );
      await page.goto('/pull-requests.html');
      const span = repoName(page, 1);
      await expect(span).toHaveAttribute('title', LONG);
      const box = await span.boundingBox();
      if (!box) throw new Error('no repo name box');
      const y = box.y + box.height / 2;
      // A native tooltip comes from the element under the pointer and its
      // ancestors, so the stretched-link overlay must not sit on top of it.
      for (const x of [
        box.x + 10,
        box.x + box.width / 2,
        box.x + box.width - 4,
      ]) {
        const hit = await page.evaluate(
          ([px, py]) => {
            const el = document.elementFromPoint(px, py);
            return el?.closest('.repo-name') ? 'text' : (el?.tagName ?? 'none');
          },
          [x, y],
        );
        expect(hit).toBe('text');
      }
      // The row stays clickable all over, the repo name included.
      await page.mouse.click(box.x + box.width / 2, y);
      await expect(
        page.getByRole('dialog', { name: /^Pull request details/ }),
      ).toBeVisible();
    });

    test('the accessible name is the text and axe passes', async ({ page }) => {
      await page.goto('/pull-requests.html');
      await expect(repoName(page, 1)).toHaveText(LONG);
      const scan = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(scan.violations).toEqual([]);
    });
  });
}
