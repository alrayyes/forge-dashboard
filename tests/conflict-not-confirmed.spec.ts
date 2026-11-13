import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A Forgejo pull request the forge refused with a conflict says Conflicting and
// names the files. One whose flag stayed false past the check window, with no
// refusal naming a conflict, says "Conflict not confirmed" and keeps the reason
// one tap away (#3308). GitHub rows are unchanged.

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'forgejo',
    repo: 'andthensome/homepage',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'conflicting',
    behind: true,
    kind: 'regular',
    ...overrides,
  };
}

const PRS = [
  makePR(1, {
    title: 'Refused naming files',
    conflictConfirmed: true,
    conflictFiles: ['a.txt', 'docs/b.md'],
  }),
  makePR(2, { title: 'Flag only', conflictConfirmed: false }),
  makePR(3, { title: 'GitHub conflict', forge: 'github' }),
];

async function open(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [
          { forge: 'forgejo', reachable: true, repoCount: 1 },
          { forge: 'github', reachable: true, repoCount: 1 },
        ],
        pullRequests: PRS,
        issues: [],
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
}

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title });

for (const theme of ['light', 'dark'] as const) {
  for (const width of [390, 820, 1280]) {
    test.describe(`${theme} at ${width}px`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 900 });
        await open(page);
      });

      test('a refused conflict says Conflicting and names where', async ({
        page,
      }) => {
        const r = row(page, 'Refused naming files');
        await expect(r.locator('.merge-pill')).toHaveText('Conflicting');
        await expect(r.locator('.merge-where')).toHaveText(
          'In a.txt, docs/b.md',
        );
      });

      test('a flag-only conflict says Conflict not confirmed, reason one tap away', async ({
        page,
      }) => {
        const r = row(page, 'Flag only');
        const pill = r.getByRole('button', { name: 'Conflict not confirmed' });
        await expect(pill).toBeVisible();
        await expect(r).not.toContainText('Conflicting');
        await expect(pill).toHaveAttribute('aria-expanded', 'false');
        await expect(r.locator('.merge-where')).toBeHidden();

        await pill.click();
        await expect(pill).toHaveAttribute('aria-expanded', 'true');
        await expect(r.locator('.merge-where')).toContainText(
          'No merge or update has been refused with a conflict yet',
        );
        // The tap does not open the pull request.
        await expect(page.locator('dialog[open]')).toHaveCount(0);

        await pill.click();
        await expect(r.locator('.merge-where')).toBeHidden();
      });

      test('a GitHub conflict is unchanged', async ({ page }) => {
        const r = row(page, 'GitHub conflict');
        await expect(r.locator('.merge-pill')).toHaveText('Conflicting');
        await expect(r.locator('.merge-where')).toHaveCount(0);
      });
    });
  }
}

// One test loops both themes and every width: the page is the same code in
// each, so six separate tests only paid for six fixtures and six loads.
test('has no axe violations, collapsed and open, in light and dark at 390, 820 and 1280px', async ({
  page,
}) => {
  const scan = () =>
    new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [390, 820, 1280]) {
      const where = `${theme} at ${width}px`;
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      expect((await scan()).violations, `${where}, collapsed`).toEqual([]);

      await row(page, 'Flag only')
        .getByRole('button', { name: 'Conflict not confirmed' })
        .click();
      expect((await scan()).violations, `${where}, open`).toEqual([]);
    }
  }
});
