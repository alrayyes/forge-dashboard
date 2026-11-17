import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A pull request's pill counts a cancelled and a held run, and a Forgejo job
// that never started, beside the others, so its segments add up to the checks
// its pipeline lists in every mix. The
// server tallies the counts; the page is fed them here and only draws them.

type Counts = Partial<Record<string, number>>;

function pr(
  number: number,
  title: string,
  ci: string,
  checks: Counts,
  forge = 'github',
) {
  return {
    forge,
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://example.test/alrayyes/app/pull/${number}`,
    author: 'claude',
    draft: false,
    ci,
    checks: {
      passed: 0,
      skipped: 0,
      running: 0,
      waiting: 0,
      failed: 0,
      unknown: 0,
      ...checks,
    },
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'blocked',
    kind: 'regular',
  };
}

// The checks each row's pipeline lists, and the segments that must add up to it.
const ROWS = [
  {
    title: 'Failed with a cancel',
    total: 8,
    counts: { passed: 5, failed: 1, cancelled: 2 },
    ci: 'failure',
    segments: ['5', '1', '2'],
  },
  {
    title: 'Going with a cancel',
    total: 7,
    counts: { passed: 3, running: 1, waiting: 1, cancelled: 2 },
    ci: 'pending',
    segments: ['3', '1', '1', '2'],
  },
  {
    title: 'Passed beside a held',
    total: 4,
    counts: { passed: 3, held: 1 },
    ci: 'pending',
    segments: ['3', '1'],
  },
  {
    title: 'Forgejo mixed run',
    total: 4,
    counts: { passed: 1, failed: 1, cancelled: 2 },
    ci: 'failure',
    segments: ['1', '1', '2'],
    forge: 'forgejo',
  },
  {
    title: 'Forgejo failed with jobs not started',
    total: 6,
    counts: { passed: 2, failed: 1, notStarted: 3 },
    ci: 'failure',
    segments: ['2', '3', '1'],
    forge: 'forgejo',
  },
];

const PRS = ROWS.map((r, i) =>
  pr(i + 1, r.title, r.ci, r.counts, 'forge' in r ? r.forge : 'github'),
);

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
        forges: [
          { forge: 'github', reachable: true, repoCount: 1 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
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
const segments = (page: Page, title: string) =>
  pill(page, title).locator('.ci-seg:not(.ci-seg-label)');

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 900 }],
  ['phone', { width: 390, height: 800 }],
] as const) {
  test.describe(`Pull request pill counts add up, ${name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('every segment is drawn, and they add up to the checks listed', async ({
      page,
    }) => {
      await open(page);

      for (const row of ROWS) {
        await expect(segments(page, row.title)).toHaveText(row.segments);
        const drawn = await segments(page, row.title).allInnerTexts();
        expect(
          drawn.reduce((sum, n) => sum + Number(n), 0),
          row.title,
        ).toBe(row.total);
      }
    });

    test('a cancelled, held and not started count are not colour alone', async ({
      page,
    }) => {
      await open(page);

      await expect(
        pill(page, 'Failed with a cancel').locator(
          '.ci-seg-cancelled .check-glyph',
        ),
      ).not.toHaveCount(0);
      await expect(
        pill(page, 'Passed beside a held').locator('.ci-seg-held .check-glyph'),
      ).not.toHaveCount(0);
      await expect(
        pill(page, 'Forgejo failed with jobs not started').locator(
          '.ci-seg-notStarted .check-glyph',
        ),
      ).not.toHaveCount(0);
      await expect(
        pill(page, 'Forgejo failed with jobs not started'),
      ).toHaveAttribute('aria-label', /2 passed, 3 not started, 1 failed/);
      await expect(pill(page, 'Failed with a cancel')).toHaveAttribute(
        'aria-label',
        /5 passed, 1 failed, 2 cancelled/,
      );
      await expect(pill(page, 'Passed beside a held')).toHaveAttribute(
        'aria-label',
        /3 passed, 1 held/,
      );
    });

    test('has no axe violations, light and dark', async ({ page }) => {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await open(page);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      }
    });
  });
}
