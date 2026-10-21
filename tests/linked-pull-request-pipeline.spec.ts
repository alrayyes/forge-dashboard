import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The pill on an issue row carries the pipeline of the pull request that will
// close it, drawn by the same code as the pull request's own row: the word,
// then a count per state. A pull request with no checks keeps the plain pill.
// Mocks /api/dashboard only.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();
const REPO = 'alrayyes/forge-dashboard';

const none = { passed: 0, running: 0, waiting: 0, failed: 0 };

const linked = (number: number, overrides: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: REPO,
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  ci: 'none',
  checks: none,
  awaitingWorkflowApproval: false,
  ...overrides,
});

const issue = (number: number, linkedPullRequests: unknown[]) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'ryankes',
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests,
});

async function mockBoard(page: Page, issues: unknown[]) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues,
      }),
    }),
  );
}

const pill = (page: Page, number: number) =>
  page
    .locator('#issue-rows .row', { hasText: `Issue ${number}` })
    .locator('.linked-pr');

test.describe('the pipeline on an issue row pill', () => {
  test('shows the word and the counts, and says them in the name', async ({
    page,
  }) => {
    await mockBoard(page, [
      issue(1, [
        linked(12, {
          ci: 'pending',
          checks: { passed: 3, running: 2, waiting: 0, failed: 1 },
        }),
      ]),
    ]);
    await page.goto('/issues.html');

    await expect(pill(page, 1)).toHaveText('#12 open Running 3 2 1');
    await expect(pill(page, 1)).toHaveAccessibleName(
      'Pull request #12 open Running 3 2 1: 3 passed, 2 running, 1 failed, closes this issue',
    );
  });

  test('a passed and a failed pipeline read in their own words', async ({
    page,
  }) => {
    await mockBoard(page, [
      issue(1, [
        linked(12, {
          ci: 'success',
          checks: { passed: 4, running: 0, waiting: 0, failed: 0 },
        }),
      ]),
      issue(2, [
        linked(13, {
          ci: 'failure',
          checks: { passed: 1, running: 0, waiting: 0, failed: 2 },
        }),
      ]),
    ]);
    await page.goto('/issues.html');

    await expect(pill(page, 1)).toHaveText('#12 open Passed 4');
    await expect(pill(page, 2)).toHaveText('#13 open Failed 1 2');
  });

  test('says a run held for approval in the pull request row’s words', async ({
    page,
  }) => {
    await mockBoard(page, [
      issue(1, [linked(12, { ci: 'failure', awaitingWorkflowApproval: true })]),
    ]);
    await page.goto('/issues.html');

    await expect(pill(page, 1)).toHaveText(
      '#12 open Waiting for workflow approval',
    );
  });

  test('keeps the plain pill when the pull request has no checks', async ({
    page,
  }) => {
    await mockBoard(page, [
      issue(1, [linked(12), linked(13, { ci: 'success' })]),
    ]);
    await page.goto('/issues.html');

    await expect(pill(page, 1).first()).toHaveText('#12 open');
    await expect(pill(page, 1).first()).toHaveAccessibleName(
      'Pull request #12 open, closes this issue',
    );
    await expect(pill(page, 1).nth(1)).toHaveText('#13 open');
    await expect(page.locator('.linked-pr .ci-pill')).toHaveCount(0);
  });

  test('shows the pipeline on the pills kept behind "N more"', async ({
    page,
  }) => {
    await mockBoard(page, [
      issue(1, [
        linked(10),
        linked(11),
        linked(12, {
          ci: 'failure',
          checks: { passed: 1, running: 0, waiting: 0, failed: 2 },
        }),
      ]),
    ]);
    await page.goto('/issues.html');
    await expect(pill(page, 1)).toHaveCount(2);

    await page.getByRole('button', { name: /^1 more/ }).click();

    await expect(pill(page, 1).nth(2)).toHaveText('#12 open Failed 1 2');
  });

  test('cuts a long cross-repo name short instead of scrolling sideways at 390 px', async ({
    page,
  }) => {
    const longRepo =
      'some-organisation/a-very-long-repository-name-for-a-phone';
    await mockBoard(page, [
      issue(1, [
        linked(123, {
          repo: longRepo,
          ci: 'pending',
          checks: { passed: 3, running: 2, waiting: 1, failed: 1 },
        }),
        linked(124, {
          repo: longRepo,
          ci: 'failure',
          awaitingWorkflowApproval: true,
        }),
      ]),
    ]);
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/issues.html');
      const first = pill(page, 1).first();
      await expect(first).toBeVisible();

      // The visible text and the name still carry the whole repo.
      await expect(first).toContainText(`${longRepo}#123 open Running 3 2 1 1`);
      await expect(first).toHaveAccessibleName(
        new RegExp(`^Pull request ${longRepo}#123 open Running`),
      );
      // Only the repo is cut: the number, state and pipeline sit inside the pill.
      const pillBox = await first.boundingBox();
      for (const part of [
        first.locator('.linked-pr-number'),
        first.locator('.ci-pill'),
      ]) {
        const inner = await part.boundingBox();
        expect(inner?.x ?? 0, scheme).toBeGreaterThanOrEqual(pillBox?.x ?? 0);
        expect(
          (inner?.x ?? 0) + (inner?.width ?? 0),
          scheme,
        ).toBeLessThanOrEqual((pillBox?.x ?? 0) + (pillBox?.width ?? 0) + 1);
      }
      await expect(first.locator('.linked-pr-number')).toHaveText('#123');
      const box = await first.boundingBox();
      expect(box?.x ?? 0, scheme).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0), scheme).toBeLessThanOrEqual(
        390,
      );
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, scheme).toBeLessThanOrEqual(0);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations, scheme).toEqual([]);
    }
  });

  test('has no accessibility violations in light, dark and at 390 px, and does not scroll sideways', async ({
    page,
  }) => {
    await mockBoard(page, [
      issue(1, [
        linked(10, {
          ci: 'pending',
          checks: { passed: 3, running: 2, waiting: 1, failed: 1 },
        }),
        linked(11, { ci: 'failure', awaitingWorkflowApproval: true }),
      ]),
      issue(2, [
        linked(12, {
          draft: true,
          ci: 'success',
          checks: { passed: 4, running: 0, waiting: 0, failed: 0 },
        }),
      ]),
    ]);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/issues.html');
        await expect(pill(page, 1).first()).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations, `${scheme} at ${width}px`).toEqual([]);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow, `${scheme} at ${width}px`).toBeLessThanOrEqual(0);
      }
    }
  });
});
