import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A long author name ends in an ellipsis with or without an avatar, and
// carries its full name as hover text while it is cut. Mocks
// /api/v1/dashboard only.
// https://github.com/alrayyes/forge-dashboard/issues/3238

const LONG = 'Alexandria Barthelemy-Montgomery de la Vega y Castellanos';
const SHORT = 'ann';
const AVATAR = 'https://avatars.example.com/u/1';
const BROKEN = 'https://avatars.example.com/broken';

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#c0392b"/></svg>',
);

function bump(number: number, author: string, authorAvatarUrl = '') {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Bump package-${number} from 1.0.0 to 1.0.1`,
    url: `https://example.com/${number}`,
    author,
    authorUrl: 'https://github.com/someone',
    authorAvatarUrl,
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'dependency',
  };
}

const PRS = [
  bump(1, LONG),
  bump(2, SHORT),
  bump(3, LONG, AVATAR),
  bump(4, LONG, BROKEN),
];

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.route(AVATAR, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG }),
  );
  await page.route(BROKEN, (route: Route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: PRS,
        issues: [],
        openIssueCount: 0,
      }),
    }),
  );
  await page.goto('/bots.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const name = (page: Page, n: number) =>
  page
    .locator('#pr-rows > .row', { hasText: `package-${n} ` })
    .locator('span.author-name');

async function expectCut(page: Page, n: number) {
  const span = name(page, n);
  await expect(span).toBeVisible();
  await expect(span).toHaveCSS('text-overflow', 'ellipsis');
  // Retries until the name is laid out and wider than its box.
  await expect
    .poll(() =>
      span.evaluate(
        (el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth,
      ),
    )
    .toBe(true);
}

for (const width of [390, 1280]) {
  test.describe(`author names on the Bots page at ${width}px (#3238)`, () => {
    test.beforeEach(async ({ page }) => open(page, width));

    test('a long name with no avatar ends in an ellipsis and carries its full name', async ({
      page,
    }) => {
      await expectCut(page, 1);
      await expect(name(page, 1)).toHaveAttribute('title', LONG);
    });

    test('a long name beside an avatar ends in an ellipsis and carries its full name', async ({
      page,
    }) => {
      await expectCut(page, 3);
      await expect(name(page, 3)).toHaveAttribute('title', LONG);
    });

    test('a name beside an avatar that failed to load still ends in an ellipsis', async ({
      page,
    }) => {
      await expect(
        page
          .locator('#pr-rows > .row', { hasText: 'package-4 ' })
          .locator('img.author-avatar'),
      ).toHaveCount(0);
      await expectCut(page, 4);
    });

    test('a name that fits carries no hover text', async ({ page }) => {
      await expect(name(page, 2)).toBeVisible();
      await expect(name(page, 2)).not.toHaveAttribute('title');
    });
  });
}
