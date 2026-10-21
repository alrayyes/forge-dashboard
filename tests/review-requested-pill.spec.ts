import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #695: a "Review requested from me" quick filter. The server says which
// pull requests ask the signed-in user (`reviewRequestedFromMe`, matched
// against the username saved in Settings for the forge); the page only
// reads it.

function pr(number: number, over: Record<string, unknown>) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `PR ${number}`,
    url: `https://example.com/${number}`,
    author: 'someone',
    draft: false,
    ci: 'success',
    mergeStatus: 'blocked',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reviewRequestedFromMe: false,
    ...over,
  };
}

const PRS = [
  pr(1, { title: 'Asks me', reviewRequestedFromMe: true }),
  pr(2, { title: 'Asks someone else' }),
  pr(3, {
    title: 'Asks me too',
    forge: 'forgejo',
    repo: 'ryan/infra',
    reviewRequestedFromMe: true,
  }),
  pr(4, { title: 'Quiet' }),
];

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [
          { forge: 'github', reachable: true, repoCount: 1 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests: PRS,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const pill = (page: Page) =>
  page
    .getByRole('group', { name: 'Quick filters' })
    .getByRole('button', { name: 'Review requested from me' });
const titles = (page: Page) => page.locator('#pr-rows > .row .title-text');

test.describe('the Review requested from me pill (#695)', () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  test('keeps the pull requests the server says ask me, is exclusive, and survives a reload', async ({
    page,
  }) => {
    await pill(page).click();
    await expect(pill(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(titles(page)).toHaveCount(2);
    await expect(titles(page).nth(0)).toContainText('Asks me');
    await expect(titles(page).nth(1)).toContainText('Asks me too');

    await page.reload();

    await expect(pill(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(titles(page)).toHaveCount(2);

    await page
      .getByRole('group', { name: 'Quick filters' })
      .getByRole('button', { name: 'All', exact: true })
      .click();
    await expect(titles(page)).toHaveCount(PRS.length);
    await expect(pill(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('has no axe violations with the pill active', async ({ page }) => {
    await pill(page).click();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
