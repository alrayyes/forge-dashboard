import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Cancelled pill says how many checks passed and how many were cancelled,
// so a run stopped seconds in reads differently from one aborted at the end.
// The server tallies the counts (checks.passed, checks.cancelled); the page
// words them.
// https://github.com/alrayyes/forge-dashboard/issues/3395

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function pr(number: number, title: string, checks: object) {
  return {
    forge: 'forgejo',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://example.test/alrayyes/app/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'cancelled',
    checks: { passed: 0, running: 0, waiting: 0, failed: 0, ...checks },
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'blocked',
    kind: 'regular',
  };
}

const PRS = [
  pr(1, 'Some passed', { passed: 4, cancelled: 9 }),
  pr(2, 'None passed', { passed: 0, cancelled: 13 }),
];

async function open(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
        pullRequests: PRS,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const pill = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title }).locator('.ci-pill');

const text = async (page: Page, title: string) =>
  (await pill(page, title).innerText()).replace(/\s+/g, ' ').trim();

const fitsWidth = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

test.describe('Cancelled pill counts (#3395)', () => {
  test('at 1280px it reads the passed and cancelled counts', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);

    expect(await text(page, 'Some passed')).toBe(
      'Cancelled · 4 passed, 9 cancelled',
    );
  });

  test('at 390px it keeps the passed count and does not overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await open(page);

    expect(await text(page, 'Some passed')).toBe('Cancelled · 4 passed');
    expect(await fitsWidth(page)).toBe(true);
  });

  test('at 320px the page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await open(page);

    expect(await fitsWidth(page)).toBe(true);
  });

  test('nothing passed leaves "0 passed" out', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);

    expect(await text(page, 'None passed')).toBe('Cancelled · 13 cancelled');
  });

  test('the name and the tooltip say the counts whole', async ({ page }) => {
    await open(page);

    const name =
      'CI status: Cancelled. 4 passed, 9 cancelled out of 13 checks.';
    await expect(pill(page, 'Some passed')).toHaveAttribute(
      'aria-label',
      `${name} Open pipeline`,
    );
    await expect(pill(page, 'Some passed')).toHaveAttribute('title', name);
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [320, 390, 1280]) {
      test(`has no axe violations at ${width}px, ${scheme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await open(page);
        const results = await new AxeBuilder({ page })
          .withTags(AXE_TAGS)
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});
