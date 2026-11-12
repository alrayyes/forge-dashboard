import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The advisory detail leaves most of a small phone to the scrolling body: the
// title block scrolls with it and the footer that repeated Back and Close is
// gone (#3390).

const TITLE =
  'Prototype pollution in lodash-es allows remote code execution via crafted input';
const REPO = 'acme-platform/critical-infrastructure-scanner';
const LIST_URL = `https://example.com/${REPO}/security/dependabot`;

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
  advisories: [advisory(1, TITLE), advisory(2, 'Short flaw')],
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

async function openDetail(page: Page) {
  await open(page, json(LIST));
  await page.getByTestId('advisory-row').first().click();
  await expect(page.getByTestId('advisory-detail')).toBeVisible();
  return page.getByTestId('advisories-dialog');
}

for (const scheme of ['light', 'dark'] as const) {
  for (const [width, height, share] of [
    [320, 568, 0.5],
    [390, 664, 0.5],
    [1280, 900, 0],
  ]) {
    test(`the detail scroll area is a fair share of ${width}x${height} in ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      const dialog = await openDetail(page);
      const body = await dialog.locator('.adv-body').boundingBox();
      expect((body?.height ?? 0) / height).toBeGreaterThanOrEqual(share);

      // The title is part of the scrolling body now.
      await expect(dialog.locator('.adv-body .adv-title')).toHaveText(TITLE);
      await expect(dialog).toHaveAccessibleName(TITLE);
      await expect(dialog.locator('.adv-footer')).toHaveCount(0);

      // Back and Close stay reachable, and at 44px on a phone.
      const min = width <= 760 ? 44 : 32;
      for (const sel of ['.adv-back', '.adv-close']) {
        const box = await dialog.locator(sel).boundingBox();
        expect(box?.height, sel).toBeGreaterThanOrEqual(min);
        expect(box?.width ? box.width : 0, sel).toBeGreaterThan(0);
      }
      expect((await dialog.locator('.adv-close').boundingBox())?.width).toBe(
        min,
      );
      await expect(dialog.getByTestId('advisory-back')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dialog.locator('.adv-close')).toBeFocused();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
