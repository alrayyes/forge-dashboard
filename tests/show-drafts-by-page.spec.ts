import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3704: a page offers Show drafts only when a draft of a kind it lists is
// hidden. The server counts them per page; the page reads its own number.

function makePR(number: number, draft: boolean, kind: string) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `${kind} change ${number}`,
    url: `https://example.com/${number}`,
    author: kind === 'dependency' ? 'dependabot[bot]' : 'claude',
    kind,
    draft,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'blocked',
    behind: false,
  };
}

// The board: one ready release pull request, one ready bot pull request, and
// a single draft, a dependency one.
const RELEASE = makePR(1, false, 'release');
const BOT = makePR(2, false, 'dependency');
const BOT_DRAFT = makePR(3, true, 'dependency');

function answer(route: Route) {
  const include =
    new URL(route.request().url()).searchParams.get('includeDrafts') === 'true';
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
      pullRequests: include ? [RELEASE, BOT, BOT_DRAFT] : [RELEASE, BOT],
      issues: [],
      repos: [],
      hiddenDrafts: include ? 0 : 1,
      hiddenDraftsByPage: {
        pullRequests: 0,
        releases: 0,
        bots: include ? 0 : 1,
      },
    }),
  });
}

async function open(page: Page, path: string, width = 1280) {
  await page.setViewportSize({ width, height: 800 });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', answer);
  await page.goto(path);
}

const toggle = (page: Page) => page.locator('#show-drafts-toggle');
const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

test.describe('show drafts per page (#3704)', () => {
  for (const width of [360, 390, 1280]) {
    test(`Releases has no button when the only draft is a dependency pull request, at ${width}px`, async ({
      page,
    }) => {
      await open(page, '/releases.html', width);
      await expect(page.locator('#pr-rows .row')).toHaveCount(1);
      // Open the phone sheet first, or the button is out of sight whatever the
      // page offers. Another control proves the sheet is open.
      if (width < 700)
        await page.getByRole('button', { name: /^Filters/ }).click();
      await expect(
        page.getByRole('combobox', { name: 'Sort pull requests by' }),
      ).toBeVisible();
      await expect(toggle(page)).toBeHidden();
      expect((await axe(page)).violations).toEqual([]);
    });

    test(`Bots shows the button and it reveals the draft, at ${width}px`, async ({
      page,
    }) => {
      await open(page, '/bots.html', width);
      await expect(page.locator('#pr-rows .row')).toHaveCount(1);
      // On a phone the filters sit in a sheet behind a Filters button.
      if (width < 700)
        await page.getByRole('button', { name: /^Filters/ }).click();
      await expect(toggle(page)).toBeVisible();
      expect((await axe(page)).violations).toEqual([]);

      await toggle(page).click();
      if (width < 700)
        await page.getByRole('button', { name: 'Close filters' }).click();
      await expect(page.locator('#pr-rows .row')).toHaveCount(2);
      await expect(page.locator('#pr-rows .attr-chip.draft')).toHaveCount(1);
      expect((await axe(page)).violations).toEqual([]);
    });
  }
});
