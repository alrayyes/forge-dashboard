import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A long package name stays inside its row in the advisories list. The package
// chip was nowrap with no max width, so a scoped npm name pushed it past the
// row and the ecosystem after the name was clipped.
// https://github.com/alrayyes/forge-dashboard/issues/3389

const REPO = 'acme-platform/critical-infrastructure-scanner';
const LIST_URL = `https://example.com/${REPO}/security/dependabot`;

const LONG_PACKAGE = `@acme-platform/${'very-long-package-name-'.repeat(2)}core-runtime-lib`;

const advisory = (n: number, summary: string) => ({
  number: n,
  state: 'open',
  severity: 'high',
  summary,
  ghsaId: `GHSA-aaaa-bbbb-${n}`,
  package: n === 1 ? LONG_PACKAGE : `pkg-${n}`,
  ecosystem: 'npm',
  manifestPath: 'requirements.txt',
  openedAt: new Date(Date.now() - n * 86_400_000).toISOString(),
  patchedVersion: '2.0.0',
  url: `${LIST_URL}/${n}`,
});

const LIST = {
  state: 'known',
  url: LIST_URL,
  advisories: [advisory(1, 'Long package'), advisory(2, 'Short flaw')],
};

const json = (body: object) => (route: Route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

async function open(page: Page, answer: (route: Route) => Promise<void>) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/main-branches/advisories*', answer);
  await page.route('**/api/v1/main-branches', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 0,
          passed: 1,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: 1,
        },
        branches: [
          {
            forge: 'github',
            fullName: REPO,
            url: `https://example.com/${REPO}`,
            branch: 'main',
            status: 'passed',
            commit: {
              sha: 'd98f3c2',
              subject: 'fix: a change',
              author: 'sre-dev',
              committedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
            },
            failingJobs: [],
            finishedAt: null,
            durationSeconds: null,
            runUrl: `https://example.com/${REPO}/actions/runs/1`,
            checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
            latestRelease: null,
            staleSince: null,
            advisories: {
              state: 'known',
              count: 2,
              highest: 'high',
              url: LIST_URL,
            },
          },
        ],
      }),
    }),
  );
  await page.goto('/');
  await page.getByTestId('main-branch-advisories').click();
  await expect(page.getByTestId('advisories-dialog')).toBeVisible();
}

for (const width of [320, 390, 820, 1280]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test('the package chip ends inside its row and keeps the ecosystem', async ({
      page,
    }) => {
      expect(LONG_PACKAGE.length).toBeGreaterThanOrEqual(60);
      await open(page, json(LIST));
      const rows = page.getByTestId('advisory-row');
      await expect(rows).toHaveCount(2);

      // Re-measured until every check holds, so a layout still settling on a
      // loaded runner doesn't fail. A missing or empty box never passes.
      const chip = page.locator('.adv-chip-package').first();
      await expect
        .poll(async () => {
          const [row, box, short] = await Promise.all([
            rows.first().boundingBox(),
            chip.boundingBox(),
            page.locator('.adv-chip-package').nth(1).boundingBox(),
          ]);
          if (!row || !box || !short) return ['a box is missing'];
          if (row.width <= 0 || box.width <= 0 || short.height <= 0)
            return ['a box is empty'];
          const problems: string[] = [];
          if (box.x < row.x) problems.push('chip starts outside the row');
          if (box.x + box.width > row.x + row.width)
            problems.push('chip ends outside the row');
          if (short.height >= 26) problems.push('short chip wraps');
          return problems;
        })
        .toEqual([]);
      // The full name and the ecosystem are in the text, not cut away.
      await expect(chip).toContainText(LONG_PACKAGE);
      await expect(chip).toContainText('npm');

      await expect
        .poll(
          () =>
            page.evaluate(
              () => document.documentElement.scrollWidth - window.innerWidth,
            ),
          { message: 'no horizontal page overflow' },
        )
        .toBeLessThanOrEqual(0);
      await expect
        .poll(
          () =>
            page
              .locator('.adv-body')
              .evaluate((el) =>
                el.clientWidth > 0 ? el.scrollWidth - el.clientWidth : NaN,
              ),
          { message: 'no horizontal dialog overflow' },
        )
        .toBeLessThanOrEqual(0);
    });

    test(`the list passes axe in both themes`, async ({ page }) => {
      for (const scheme of ['light', 'dark'] as const) {
        await test.step(`${scheme}`, async () => {
          await page.emulateMedia({ colorScheme: scheme });

          await open(page, json(LIST));

          await expect(page.getByTestId('advisory-row')).toHaveCount(2);

          const results = await new AxeBuilder({ page })
            .include('[data-testid="advisories-dialog"]')
            .analyze();

          expect(results.violations).toEqual([]);
        });
      }
    });
  });
}
