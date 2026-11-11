import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3403
//
// The details dialogs draw a label as an .attr-chip. It kept white-space:
// nowrap, so a 77-character label ran past the dialog's edge on a phone.

const LONG =
  'kind/a-very-long-label-name-that-keeps-going-and-going-for-a-full-77-chars';
const NOW = new Date().toISOString();

const PR = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 1,
  title: 'Pull request 1',
  url: 'https://example.com/1',
  author: 'ryankes',
  draft: false,
  ci: 'success',
  labels: [{ name: LONG, color: 'cccccc' }],
  createdAt: NOW,
  updatedAt: NOW,
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
};
const ISSUE = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 2,
  title: 'Issue 2',
  url: 'https://example.com/issues/2',
  author: 'ryankes',
  labels: [{ name: LONG, color: 'cccccc' }],
  createdAt: NOW,
  updatedAt: NOW,
};

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const details = {
  description: {
    text: 'Body.',
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
};

async function mock(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: NOW,
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [PR],
        issues: [ISSUE],
      }),
    }),
  );
  await page.route('**/api/v1/*/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(details),
    }),
  );
}

test.describe('a long label name stays inside the details dialog (#3403)', () => {
  for (const [name, path, rows, dialogName] of [
    [
      'Pull request',
      '/pull-requests.html',
      '#pr-rows',
      /^Pull request details/,
    ],
    ['Issue', '/issues.html', '#issue-rows', /^Issue details/],
  ] as const) {
    for (const [width, scheme] of [
      [320, 'light'],
      [390, 'light'],
      [820, 'light'],
      [1280, 'light'],
      [320, 'dark'],
    ] as const) {
      test(`${name} dialog: chip fits at ${width}px, ${scheme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        await mock(page);
        await page.goto(path);
        await page
          .locator(`${rows} > .row`)
          .first()
          .getByRole('button', { name: /^#\d+ / })
          .click();
        const dialog = page.getByRole('dialog', { name: dialogName });
        await expect(dialog).toBeVisible();
        const chip = dialog.locator('.attr-chip.label');
        await expect(chip).toHaveCount(1);
        const d = await dialog.boundingBox();
        const c = await chip.boundingBox();
        expect(d && c).toBeTruthy();
        if (!d || !c) return;
        expect(c.x + c.width).toBeLessThanOrEqual(d.x + d.width);
        expect(c.x).toBeGreaterThanOrEqual(d.x);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth >
              document.documentElement.clientWidth,
          ),
        ).toBe(false);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});
