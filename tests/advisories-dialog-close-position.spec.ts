import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The close X stays in the top-right corner of the advisories dialog, level
// with the title, at every width. On a phone the header used to wrap, which
// dropped the X onto a row of its own below the title and the repo line.
// https://github.com/alrayyes/forge-dashboard/issues/3357

const REPO = 'acme-platform/critical-infrastructure-scanner';
const LIST_URL = `https://example.com/${REPO}/security/dependabot`;

const LONG = `A very long summary ${'that keeps wrapping '.repeat(8)}`;

const advisory = (n: number, summary: string) => ({
  number: n,
  state: 'open',
  severity: 'high',
  summary,
  ghsaId: `GHSA-aaaa-bbbb-${n}`,
  package: `pkg-${n}`,
  ecosystem: 'pip',
  manifestPath: 'requirements.txt',
  openedAt: new Date(Date.now() - n * 86_400_000).toISOString(),
  patchedVersion: '2.0.0',
  url: `${LIST_URL}/${n}`,
});

const LIST = {
  state: 'known',
  url: LIST_URL,
  advisories: [advisory(1, LONG), advisory(2, 'Short flaw')],
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

// The X sits inside the dialog's top-right corner and no lower than the title
// row: its top is above the title's bottom, so nothing wrapped under it.
async function expectTopRight(page: Page, label: string) {
  const dialog = page.getByTestId('advisories-dialog');
  const box = async (sel: string) => {
    const b = await dialog.locator(sel).first().boundingBox();
    if (!b) throw new Error(`${sel} has no box`);
    return b;
  };
  const frame = await box(':scope');
  const x = await box('.adv-close');
  const title = await box('.adv-title');
  const header = await box('.adv-header');
  expect(
    frame.x + frame.width - (x.x + x.width),
    `${label} right`,
  ).toBeLessThan(24);
  expect(x.y - header.y, `${label} top`).toBeLessThan(20);
  expect(x.y, `${label} level with title`).toBeLessThan(title.y + title.height);
  expect(x.width, `${label} target`).toBeGreaterThanOrEqual(
    (page.viewportSize()?.width ?? 1280) <= 760 ? 44 : 32,
  );
}

for (const width of [320, 390, 820, 1280]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test('the X is top-right while the list loads', async ({ page }) => {
      await open(page, () => new Promise(() => {}));
      await expect(page.getByText('Loading advisories')).toBeVisible();
      await expectTopRight(page, 'loading');
    });

    test('the X is top-right on the list and the detail, and the rest holds', async ({
      page,
    }) => {
      await open(page, json(LIST));
      const dialog = page.getByTestId('advisories-dialog');
      await expect(page.getByTestId('advisory-row')).toHaveCount(2);
      await expectTopRight(page, 'list');

      // Focus order is unchanged: Open on GitHub, then the X.
      const link = dialog.getByTestId('advisory-open-on-forge');
      await expect(link).toBeVisible();
      await link.focus();
      await page.keyboard.press('Tab');
      await expect(dialog.locator('.adv-close')).toBeFocused();

      // The footer Close is still there.
      await expect(
        dialog.locator('.adv-footer').getByRole('button', { name: 'Close' }),
      ).toBeVisible();

      await page.getByTestId('advisory-row').first().click();
      await expect(page.getByTestId('advisory-detail')).toBeVisible();
      await expectTopRight(page, 'detail');
      await expect(dialog.getByTestId('advisory-back')).toBeFocused();
      // The long title wraps inside its column and does not push the X away.
      const title = await dialog.locator('.adv-title').boundingBox();
      const x = await dialog.locator('.adv-close').boundingBox();
      expect((title?.x ?? 0) + (title?.width ?? 0)).toBeLessThanOrEqual(
        x?.x ?? 0,
      );
      await expect(link).toBeVisible();
    });
  });
}
