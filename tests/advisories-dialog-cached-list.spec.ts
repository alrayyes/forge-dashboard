import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The advisories dialog opens at once: the row's count and severity sit in its
// header before any list arrives, a kept list shows without a loading line, a
// refresh loads behind the list that is already there, and none of it moves
// the text under the reader.
// https://github.com/alrayyes/forge-dashboard/issues/4192

const REPO = 'acme/critical';
const READ_AT = new Date(Date.now() - 4 * 60_000).toISOString();

function branch(warm: boolean) {
  return {
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
      count: 12,
      highest: 'critical',
      url: `https://example.com/${REPO}/security/dependabot`,
      ...(warm ? { listReadAt: READ_AT } : {}),
    },
  };
}

function advisory(n: number, severity: string) {
  return {
    number: n,
    state: 'open',
    severity,
    summary: `Flaw number ${n} in a dependency`,
    ghsaId: `GHSA-aaaa-bbbb-${n}`,
    package: `pkg-${n}`,
    ecosystem: 'pip',
    scope: 'runtime',
    relationship: 'direct',
    manifestPath: 'requirements.txt',
    openedAt: new Date(Date.now() - n * 86_400_000).toISOString(),
    url: `https://example.com/${REPO}/security/dependabot/${n}`,
  };
}

const ITEMS = Array.from({ length: 12 }, (_, i) =>
  advisory(i + 1, i === 0 ? 'critical' : i < 4 ? 'high' : 'low'),
);
const list = (over: object = {}) => ({
  state: 'known',
  url: `https://example.com/${REPO}/security/dependabot`,
  readAt: READ_AT,
  advisories: ITEMS,
  ...over,
});

const json = (body: object) => (route: Route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

// Open the dialog on a row, with the list answered by `answer`. A refresh (the
// request carrying refresh=true) is answered by `refresh`.
async function openDialog(
  page: Page,
  opts: {
    warm: boolean;
    answer: (route: Route) => Promise<void>;
    refresh?: (route: Route) => Promise<void>;
  },
) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/main-branches/advisories*', (route) =>
    route.request().url().includes('refresh=true') && opts.refresh
      ? opts.refresh(route)
      : opts.answer(route),
  );
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
        branches: [branch(opts.warm)],
      }),
    }),
  );
  await page.goto('/');
  await page.getByTestId('main-branch-advisories').click();
  await expect(page.getByTestId('advisories-dialog')).toBeVisible();
}

async function noViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, label).toEqual([]);
}

const boxOf = async (page: Page, testId: string) => {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, testId).not.toBeNull();
  return box!;
};

// A hold the test releases when it is ready for the list to arrive.
function hold() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
}

for (const width of [1280, 375]) {
  test.describe(`advisories dialog, cached list, ${width}px wide`, () => {
    test.use({ viewport: { width, height: 800 } });

    test('the header says the count and severity before the list arrives', async ({
      page,
    }) => {
      const h = hold();
      await openDialog(page, {
        warm: false,
        answer: async (route) => {
          await h.gate;
          await json(list())(route);
        },
      });

      await expect(page.getByTestId('advisories-summary')).toHaveText(
        '12 advisories, critical',
      );
      await expect(page.getByTestId('advisories-loading')).toBeVisible();
      await expect(page.getByTestId('advisory-row')).toHaveCount(0);
      await noViolations(page, 'loading');
      const loadingDialog = await boxOf(page, 'advisories-dialog');
      const loadingHeader = await boxOf(page, 'advisories-header');

      h.release();
      await expect(page.getByTestId('advisory-row')).toHaveCount(12);

      expect(await boxOf(page, 'advisories-dialog')).toEqual(loadingDialog);
      expect(await boxOf(page, 'advisories-header')).toEqual(loadingHeader);
      await noViolations(page, 'ready');
    });

    test('a row with a kept list shows no loading line', async ({ page }) => {
      const h = hold();
      await openDialog(page, {
        warm: true,
        answer: async (route) => {
          await h.gate;
          await json(list())(route);
        },
      });

      await expect(page.getByTestId('advisories-summary')).toBeVisible();
      await expect(page.getByTestId('advisories-loading')).toHaveCount(0);
      h.release();
      await expect(page.getByTestId('advisory-row')).toHaveCount(12);
      await expect(page.getByTestId('advisories-loading')).toHaveCount(0);
    });

    test('a refresh with the same content changes no DOM and moves nothing', async ({
      page,
    }) => {
      const h = hold();
      await openDialog(page, {
        warm: true,
        answer: json(list()),
        refresh: async (route) => {
          await h.gate;
          await json(list({ readAt: new Date().toISOString() }))(route);
        },
      });
      await expect(page.getByTestId('advisory-row')).toHaveCount(12);
      await page.getByTestId('advisory-row').nth(5).scrollIntoViewIfNeeded();
      const scroller = page.locator('.adv-body');
      const top = await scroller.evaluate((el) => el.scrollTop);
      const html = await page.locator('.adv-body').innerHTML();
      const boxes = await page
        .getByTestId('advisory-row')
        .evaluateAll((rows) =>
          rows.map((r) => JSON.stringify(r.getBoundingClientRect())),
        );

      await page.getByTestId('advisories-refresh').click();
      await expect(page.getByTestId('advisories-refresh')).toHaveAttribute(
        'aria-busy',
        'true',
      );
      // The list stays up while the read is out.
      await expect(page.getByTestId('advisory-row')).toHaveCount(12);
      h.release();
      await expect(page.getByTestId('advisories-refresh')).not.toHaveAttribute(
        'aria-busy',
        'true',
      );

      expect(await page.locator('.adv-body').innerHTML()).toBe(html);
      expect(await scroller.evaluate((el) => el.scrollTop)).toBe(top);
      expect(
        await page
          .getByTestId('advisory-row')
          .evaluateAll((rows) =>
            rows.map((r) => JSON.stringify(r.getBoundingClientRect())),
          ),
      ).toEqual(boxes);
    });

    test('changed content keeps the row being read where it was', async ({
      page,
    }) => {
      const added = [advisory(20, 'critical'), advisory(21, 'critical')];
      await openDialog(page, {
        warm: true,
        answer: json(list()),
        refresh: json(list({ advisories: [...added, ...ITEMS] })),
      });
      await expect(page.getByTestId('advisory-row')).toHaveCount(12);
      const reading = page.locator('[data-number="6"]');
      await reading.scrollIntoViewIfNeeded();
      const before = (await reading.boundingBox())!.y;

      await page.getByTestId('advisories-refresh').click();
      await expect(page.getByTestId('advisory-row')).toHaveCount(14);

      expect(Math.abs((await reading.boundingBox())!.y - before)).toBeLessThan(
        1.5,
      );
    });

    test('a failed refresh keeps the list and says it is older', async ({
      page,
    }) => {
      await openDialog(page, {
        warm: true,
        answer: json(list()),
        refresh: json(list({ refreshFailed: true })),
      });
      await expect(page.getByTestId('advisory-row')).toHaveCount(12);
      const slot = await boxOf(page, 'advisories-older');
      const firstRow = (await page
        .getByTestId('advisory-row')
        .first()
        .boundingBox())!;

      await page.getByTestId('advisories-refresh').click();

      await expect(page.getByTestId('advisories-older')).toContainText(
        "Couldn't refresh. Showing the list read 4 min ago.",
      );
      await expect(page.getByTestId('advisory-row')).toHaveCount(12);
      // The line had its room reserved, so the list did not drop.
      expect((await boxOf(page, 'advisories-older')).height).toBe(slot.height);
      expect(
        await page.getByTestId('advisory-row').first().boundingBox(),
      ).toEqual(firstRow);
      await noViolations(page, 'older');
    });
  });
}
