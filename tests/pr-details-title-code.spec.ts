import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// Paired backticks in the details pop-up title show as inline code.
// The splitting rules are unit tested in web/src/lib/title-code.test.ts; this
// spec proves the wiring, the look and the layout once.
// https://github.com/alrayyes/forge-dashboard/issues/3358
// Mocks /api/v1/dashboard and /api/v1/pull-requests/details only.

const BUMP = 'fix(deps): bump golang from `d9b6a1b` to `dc0963f`';

async function openDialog(page: Page, title: string) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route) =>
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
            title,
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
  await page.route('**/api/v1/pull-requests/details*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: null,
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
  test(`paired backticks show as inline code (${scheme}, 320px)`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 320, height: 740 });
    const dialog = await openDialog(page, BUMP);
    const title = dialog.locator('.details-title');

    await expect(title).toHaveText(
      'fix(deps): bump golang from d9b6a1b to dc0963f',
    );
    const spans = title.locator('code');
    await expect(spans).toHaveText(['d9b6a1b', 'dc0963f']);

    // Monospace face and a tint that differs from the dialog surface.
    await expect(spans.first()).toHaveCSS('font-family', /mono/i);
    await expect(spans.first()).not.toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );

    // A digest never breaks mid-word.
    for (const box of await spans.evaluateAll((els) =>
      els.map((el) => el.getClientRects().length),
    )) {
      expect(box).toBe(1);
    }

    const overflow = await dialog.evaluate(
      (el) => el.scrollWidth - el.clientWidth,
    );
    expect(overflow).toBe(0);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('an odd number of backticks shows as typed', async ({ page }) => {
  const dialog = await openDialog(page, 'bump `a` to `b');
  const title = dialog.locator('.details-title');
  await expect(title).toHaveText('bump `a` to `b');
  await expect(title.locator('code')).toHaveCount(0);
});

test('HTML in a title shows as text and injects nothing', async ({ page }) => {
  const dialog = await openDialog(
    page,
    'x <img src=x onerror="window.__pwned=1"> `<b>y</b>`',
  );
  const title = dialog.locator('.details-title');
  await expect(title).toHaveText(
    'x <img src=x onerror="window.__pwned=1"> <b>y</b>',
  );
  await expect(title.locator('img, b')).toHaveCount(0);
  const pwned = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__pwned,
  );
  expect(pwned).toBeUndefined();
});
