import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// Task list items in the details pop-up show as read-only checkboxes.
// https://github.com/alrayyes/forge-dashboard/issues/1655
// Mocks /api/dashboard and /api/pull-requests/details only, so it starts from
// the shared session.
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

const reactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

const DESCRIPTION = [
  'Checklist:',
  '',
  '- [x] done item',
  '- [ ] open item with a [link](https://example.org/x)',
  '- plain `[x]` in code, [x] mid-sentence',
  '',
  'Not a task: [x] mid-sentence.',
].join('\n');

async function openDialog(page: Page) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [
          {
            forge: 'github',
            repo: 'alrayyes/forge-dashboard',
            number: 42,
            title: 'Add structured logging',
            url: 'https://example.com/42',
            author: 'ryankes',
            draft: false,
            ci: 'success',
            labels: [],
            createdAt: new Date(Date.now() - 3_600_000).toISOString(),
            updatedAt: new Date().toISOString(),
            mergeStatus: 'mergeable',
            behind: false,
            kind: 'regular',
          },
        ],
        issues: [],
      }),
    }),
  );
  await page.route('**/api/pull-requests/details*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: DESCRIPTION,
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions,
        },
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
        releaseNotes: null,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: /^Details/ })
    .click();
  const dialog = page.getByRole('dialog', { name: /^Pull request details/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const scheme of ['light', 'dark'] as const) {
  test(`task list items are read-only checkboxes (${scheme}, 360px)`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 360, height: 740 });
    const dialog = await openDialog(page);

    const done = dialog.getByRole('checkbox', { name: 'done item' });
    const open = dialog.getByRole('checkbox', {
      name: 'open item with a link',
    });
    await expect(done).toBeChecked();
    await expect(open).not.toBeChecked();
    await expect(dialog.getByRole('checkbox')).toHaveCount(2);
    await expect(done).toBeDisabled();
    await expect(open).toBeDisabled();

    // A click changes nothing.
    await done.click({ force: true });
    await open.click({ force: true });
    await expect(done).toBeChecked();
    await expect(open).not.toBeChecked();

    // No literal task markers; [x] elsewhere is unchanged.
    const text = dialog.locator('.details-body .markdown').first();
    await expect(text).not.toContainText('[ ]');
    await expect(text.locator('code')).toHaveText('[x]');
    await expect(text).toContainText('mid-sentence');
    await expect(text).toContainText('Not a task: [x] mid-sentence.');

    // The checkbox sits next to its text and the sheet doesn't scroll sideways.
    const overflow = await dialog.evaluate(
      (el) => el.scrollWidth - el.clientWidth,
    );
    expect(overflow).toBe(0);
    const box = await done.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(12);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
