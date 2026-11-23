import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

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
const BLOCKED = pr(4, { title: 'Blocked', mergeStatus: 'blocked' });
const READY = pr(1, { title: 'Ready' });

async function open(page: Page, pullRequests: unknown[]) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
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
    has: page.locator('.title-text', { hasText: new RegExp(`\\d ${title}$`) }),
  });

test.describe('the status area on a pull request row (#1375)', () => {
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
    // Close is the way out, and is still offered (in the dialog, with Hide).
    const footer = actionsFooter(await openActionsDialog(empty));
    await expect(
      footer.getByRole('button', { name: 'Close pull request', exact: true }),
    ).toBeVisible();
  });

  test('a pull request the forge blocks keeps its reason in the status area, not beside the button', async ({
    page,
  }) => {
    await open(page, [EMPTY, BLOCKED, READY]);
    const blocked = row(page, 'Blocked');
    const merge = blocked.getByRole('button', { name: 'Merge', exact: true });

    await expect(blocked.locator('.status-area')).toContainText(
      'Blocked by the forge',
    );
    await expect(blocked.locator('.row-action-note')).toHaveCount(0);
    await expect(
      blocked.locator('.row-action-locked .status-area'),
    ).toHaveCount(0);
    await expect(merge).toHaveAttribute('aria-disabled', 'true');
    // The reason is read without hovering: Merge is described by the area.
    const areaId = await blocked
      .locator('.status-area-text')
      .getAttribute('id');
    await expect(merge).toHaveAttribute('aria-describedby', areaId ?? '');
    await expect(merge).toHaveAccessibleDescription(/Blocked by the forge/);
  });

  test('a pull request that only waits on CI has no status area and no locked Merge (#4528)', async ({
    page,
  }) => {
    await open(page, [EMPTY, WAITING, READY]);
    const waiting = row(page, 'Waiting');

    await expect(waiting.locator('.status-area')).toHaveCount(0);
    await expect(waiting.getByText('Waiting for CI')).toBeVisible();
    await expect(
      waiting.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveCount(0);
  });

  test('auto-merge on a waiting row leaves one place for the wait (#4528)', async ({
    page,
  }) => {
    await open(page, [
      pr(2, {
        title: 'Waiting',
        ci: 'pending',
        mergeStatus: 'blocked',
        autoMergeEnabled: true,
      }),
    ]);
    const waiting = row(page, 'Waiting');

    await expect(waiting.locator('.status-area')).toHaveCount(0);
    await expect(waiting.getByText('Merge unlocks automatically')).toHaveCount(
      0,
    );
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

  test(`has no axe-core violations on every size, and the area stays inside its row`, async ({
    page,
  }) => {
    for (const [label, size] of [
      ['desktop', { width: 1280, height: 800 }],
      ['a 360px phone', { width: 360, height: 740 }],
    ] as const) {
      await test.step(`${label}`, async () => {
        await page.setViewportSize(size);

        await open(page, [EMPTY, BLOCKED, READY]);

        for (const title of ['Empty', 'Blocked']) {
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
});
