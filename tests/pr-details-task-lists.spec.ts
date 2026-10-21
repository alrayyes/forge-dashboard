import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// Task list items in the details pop-up show as read-only checkboxes.
// https://github.com/alrayyes/forge-dashboard/issues/1655
// Mocks /api/dashboard and /api/pull-requests/details only.

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
  `- [x] foo\`code\`bar and *em*baz plus a [link](https://example.org/x)tail, ${'then a long wrapped line '.repeat(6)}`,
  '',
  'Not a task: [x] mid-sentence.',
].join('\n');

async function openDialog(page: Page, description = DESCRIPTION) {
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
          text: description,
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
    .getByRole('button', { name: /^#\d+ / })
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
    await expect(dialog.getByRole('checkbox')).toHaveCount(3);
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
    await expect(text.locator('code').first()).toHaveText('[x]');
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

for (const scheme of ['light', 'dark'] as const) {
  test(`an item with inline formatting flows as normal text (${scheme}, 360px)`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 360, height: 740 });
    const inline = `foo\`code\`bar and *em*baz plus a [link](https://example.org/x)tail, ${'then a long wrapped line '.repeat(6)}`;
    const dialog = await openDialog(page, `- [x] ${inline}\n\n${inline}`);
    const label = dialog.locator('label.task');
    await expect(label).toHaveCount(1);
    const task = await label.boundingBox();
    const para = await dialog
      .locator('.details-body .markdown > p')
      .first()
      .boundingBox();
    if (!task || !para) throw new Error('missing boxes');
    // The same text as a plain paragraph is the baseline: a flex label made
    // one-word columns and was far taller. One extra line covers the indent.
    expect(task.height).toBeLessThanOrEqual(para.height + 22);
    // The text stays whole: no flex-item gaps inside the words.
    await expect(label).toContainText('foocodebar and embaz plus a linktail');
    // The box sits on the first line.
    const box = await label.locator('input').boundingBox();
    expect(box && box.y - task.y).toBeLessThan(12);
    expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(
      0,
    );
  });
}

test('in forced-colors mode a checked box differs from an unchecked one', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.setViewportSize({ width: 360, height: 740 });
  const dialog = await openDialog(page);
  const checked = await dialog
    .getByRole('checkbox', { name: 'done item' })
    .screenshot();
  const open = await dialog
    .getByRole('checkbox', { name: 'open item with a link' })
    .screenshot();
  expect(checked.equals(open)).toBe(false);
  // The drawn tick is a fixed-colour image that forced colours can't recolour,
  // so the native control (which keeps its own state mark) takes over.
  const appearance = await dialog
    .getByRole('checkbox', { name: 'done item' })
    .evaluate((el) => getComputedStyle(el).appearance);
  expect(appearance).not.toBe('none');
});
