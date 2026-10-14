import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// #1375: one dedicated place on the row for what a pull request is waiting on
// or blocked by. The server's `status` fills it; an empty pull request offers
// Close only, with the reason in that place. The loose note beside a locked
// Merge is gone.
// https://github.com/alrayyes/forge-dashboard/issues/1375

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
    ...overrides,
  };
}

const EMPTY = pr(3, { title: 'Empty', empty: true });
const WAITING = pr(2, {
  title: 'Waiting',
  ci: 'pending',
  mergeStatus: 'blocked',
});
const READY = pr(1, { title: 'Ready' });

async function open(page: Page, pullRequests: unknown[]) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(
    pullRequests.length,
  );
}

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row').filter({
    has: page.locator('.title-text', { hasText: new RegExp(`\\d${title}$`) }),
  });

test.describe('the status area on a pull request row (#1375)', () => {
  // Writes nothing per user, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('an empty pull request offers Close and no Merge, and says why in words', async ({
    page,
  }) => {
    await open(page, [EMPTY, WAITING, READY]);
    const empty = row(page, 'Empty');

    await expect(empty.locator('.status-area')).toContainText(
      'Nothing to merge: the branch is already on the target branch.',
    );
    await expect(empty.locator('.status-area')).toContainText(
      'Close it. There is nothing left to land.',
    );
    await expect(
      empty.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveCount(0);
    await expect(
      empty.getByRole('button', { name: /Enable auto-merge/ }),
    ).toHaveCount(0);
    // Close is the way out, and is still offered (in More actions, with Hide).
    await empty.getByRole('button', { name: 'More actions' }).click();
    await expect(
      empty.getByRole('button', { name: /^Close/ }).first(),
    ).toBeVisible();
  });

  test('a pull request waiting on CI keeps its reason in the status area, not beside the button', async ({
    page,
  }) => {
    await open(page, [EMPTY, WAITING, READY]);
    const waiting = row(page, 'Waiting');
    const merge = waiting.getByRole('button', { name: 'Merge', exact: true });

    await expect(waiting.locator('.status-area')).toContainText(
      'Waiting for CI to finish',
    );
    await expect(waiting.locator('.status-area')).toContainText(
      'Merge unlocks automatically',
    );
    await expect(waiting.locator('.row-action-note')).toHaveCount(0);
    await expect(
      waiting.locator('.row-action-locked .status-area'),
    ).toHaveCount(0);
    await expect(merge).toHaveAttribute('aria-disabled', 'true');
    // The reason is read without hovering: Merge is described by the area.
    const areaId = await waiting.locator('.status-area').getAttribute('id');
    await expect(merge).toHaveAttribute('aria-describedby', areaId ?? '');
    await expect(merge).toHaveAccessibleDescription(/Waiting for CI to finish/);
  });

  test('a pull request nothing holds back has no status area', async ({
    page,
  }) => {
    await open(page, [EMPTY, WAITING, READY]);

    await expect(row(page, 'Ready').locator('.status-area')).toHaveCount(0);
    await expect(
      row(page, 'Ready').getByRole('button', { name: 'Merge', exact: true }),
    ).toBeEnabled();
  });

  for (const [label, size] of [
    ['desktop', { width: 1280, height: 800 }],
    ['a 360px phone', { width: 360, height: 740 }],
  ] as const) {
    test(`has no axe-core violations on ${label}, and the area stays inside its row`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, [EMPTY, WAITING, READY]);

      for (const title of ['Empty', 'Waiting']) {
        const r = row(page, title);
        const area = await r.locator('.status-area').boundingBox();
        const box = await r.boundingBox();
        expect((area?.x ?? 0) + (area?.width ?? 0)).toBeLessThanOrEqual(
          (box?.x ?? 0) + (box?.width ?? 0) + 1,
        );
      }
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
