import { expect, type Page, type Route } from '@playwright/test';
import { openActionsDialog } from './actions-dialog-helper';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3271
//
// On a short screen (a phone held sideways, 400% zoom) the header and footer
// of the details dialog are flex: none, so the description and comments got a
// strip of 14% of the height or less. The body keeps a usable minimum and the
// dialog scrolls as a whole when that does not fit.

const now = new Date().toISOString();
const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

const pr = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 42,
  title: 'Add structured logging to every request handler in the API',
  url: 'https://example.com/42',
  author: 'ryankes',
  draft: false,
  ci: 'failure',
  labels: [
    { name: 'kind/feature', color: 'a2eeef' },
    { name: 'topic/logging', color: 'cccccc' },
  ],
  createdAt: now,
  updatedAt: now,
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
  allowedActions: [{ action: 'merge', primary: true }, { action: 'close' }],
};

const long = Array.from(
  { length: 30 },
  (_, i) => `Paragraph ${i} of a long description.`,
).join('\n\n');

async function open(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: now,
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pr],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: long,
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions: noReactions,
        },
        comments: Array.from({ length: 12 }, (_, i) => ({
          id: `c${i}`,
          author: { login: 'alice', avatarUrl: '' },
          createdAt: now,
          updatedAt: null,
          edited: false,
          text: `Comment ${i}`,
          format: 'markdown',
          truncated: false,
          reactions: noReactions,
        })),
        commentCount: 12,
        commentsTruncated: false,
        releaseNotes: null,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows .row')).toHaveCount(1);
  const dialog = await openActionsDialog(page.locator('#pr-rows .row').first());
  await expect(dialog.locator('.details-body .markdown').first()).toBeVisible();
  return dialog;
}

for (const size of [
  { width: 667, height: 375 },
  { width: 844, height: 390 },
  { width: 320, height: 256 },
]) {
  test(`${size.width}x${size.height}: the body keeps 120px and every footer action is reachable`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const dialog = await open(page);

    const body = await dialog.locator('.details-body').boundingBox();
    expect(body?.height).toBeGreaterThanOrEqual(120);

    const buttons = dialog.locator('.details-footer').getByRole('button');
    expect(await buttons.count()).toBeGreaterThanOrEqual(3);
    for (const button of await buttons.all()) {
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
        size.height + 1,
      );
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        size.width + 1,
      );
    }

    const overflowX = await page.evaluate(() => {
      const d = document.querySelector('.details-dialog') as HTMLElement;
      return d.scrollWidth - d.clientWidth;
    });
    expect(overflowX).toBeLessThanOrEqual(0);
  });
}

// The minimum must not become a fixed size: with room to spare the body
// grows into it, as it did before (152px body, 351px dialog on main).
test('844x390: the dialog fills its 90vh cap and the body is no smaller than before', async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  const dialog = await open(page);
  const body = await dialog.locator('.details-body').boundingBox();
  const box = await dialog.boundingBox();
  expect(body?.height).toBeGreaterThanOrEqual(150);
  expect(box?.height).toBeGreaterThanOrEqual(Math.floor(390 * 0.9) - 1);
});

test('390x844 portrait: the body still takes more than half the height', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await open(page);
  const body = await dialog.locator('.details-body').boundingBox();
  expect(body?.height).toBeGreaterThan(844 / 2);
});

// https://github.com/alrayyes/forge-dashboard/issues/3404
//
// At 500px of height the footer actions must be on screen once the one
// scroll region is scrolled to its end, and tall enough to touch.
for (const size of [
  { width: 320, height: 500 },
  { width: 390, height: 500 },
]) {
  test(`${size.width}x${size.height}: scrolled to the end, the footer actions are on screen and 44px tall`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const dialog = await open(page);
    await dialog.evaluate((d) => {
      d.scrollTop = d.scrollHeight;
    });
    const buttons = dialog.locator('.details-footer').getByRole('button');
    for (const button of await buttons.all()) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
        size.height + 1,
      );
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
}

// Criterion 4 of #3404: the issue details dialog shares the component.
test('320x500 issue dialog: scrolled to the end, both actions are on screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 500 });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: now,
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [
          {
            forge: 'github',
            repo: 'alrayyes/a-very-long-repository-name-for-the-dialog',
            number: 7,
            title:
              'The page loses its place when a long title wraps over several lines',
            url: 'https://example.com/issues/7',
            author: 'ryankes',
            labels: [
              { name: 'kind/bug', color: 'd73a4a' },
              { name: 'topic/layout', color: 'cccccc' },
              { name: 'a-rather-long-label-name', color: 'ffcc00' },
            ],
            createdAt: now,
            updatedAt: now,
          },
        ],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.route('**/api/v1/issues/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: long,
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions: noReactions,
        },
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
      }),
    }),
  );
  await page.goto('/issues.html');
  await page.locator('#issue-rows .row').getByRole('button').first().click();
  const dialog = page.getByRole('dialog', { name: /^Issue details/ });
  await expect(dialog.locator('.details-body .markdown').first()).toBeVisible();
  await dialog.evaluate((d) => {
    d.scrollTop = d.scrollHeight;
  });
  const buttons = dialog.locator('.details-actions button');
  expect(await buttons.count()).toBe(2);
  for (const button of await buttons.all()) {
    const box = await button.boundingBox();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(501);
  }
});
