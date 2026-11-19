import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// A Dependabot description is HTML inside Markdown (#4241). Opened in the
// dialog it shows as collapsible release notes, lists, a quote and code, not
// as angle brackets, and nothing the author wrote can run, load or restyle.

const BODY = readFileSync(
  path.join(__dirname, '../web/src/lib/fixtures/dependabot-body.txt'),
  'utf8',
);
const HOSTILE = `${BODY}\n<script>window.__pwned = 1</script>\n<img src="https://evil.example/p.gif">\n<p onclick="window.__pwned = 2" style="position:fixed;inset:0">x</p>\n<a href="javascript:window.__pwned = 3">js</a>\n<details>\n<details>\n<details>`;

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

async function open(page: Page, text: string) {
  const now = new Date().toISOString();
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: now,
        forges: [forgeHealth('github')],
        pullRequests: [
          {
            forge: 'github',
            repo: 'alrayyes/forge-dashboard',
            number: 42,
            title: 'chore(deps): bump peter-evans/create-pull-request',
            url: 'https://example.com/42',
            author: 'dependabot',
            draft: false,
            ci: 'success',
            labels: [],
            createdAt: now,
            updatedAt: now,
            mergeStatus: 'mergeable',
            behind: false,
            kind: 'dependency',
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
        description: {
          text,
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions: noReactions,
        },
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
        releaseNotes: null,
      }),
    }),
  );
  await page.goto('/bots.html');
  await page.getByRole('button', { name: /^#42 / }).click();
  const dialog = page.getByRole('dialog', { name: /^Pull request details/ });
  await dialog.getByText('Show the generated description').click();
  return dialog;
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    test(`a Dependabot description renders as structure at ${width}px in ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 800 });
      const dialog = await open(page, BODY);
      const md = dialog.locator('.markdown');
      await expect(md.locator('details')).toHaveCount(3);
      await expect(md.getByText('Release notes')).toBeVisible();
      await expect(md).not.toContainText('<details>');
      await expect(md).not.toContainText('<summary>');
      await expect(md.locator('blockquote ul li')).not.toHaveCount(0);
      // Collapsed until opened.
      await expect(md.locator('blockquote code').first()).toBeHidden();
      await md.locator('summary', { hasText: 'Release notes' }).click();
      await expect(md.locator('blockquote code').first()).toBeVisible();

      await md.locator('summary', { hasText: 'Commits' }).click();
      await expect(md.locator('details[open] li').first()).toBeVisible();

      // Links keep the link rules.
      for (const a of await md.locator('a').all()) {
        await expect(a).toHaveAttribute('rel', 'noopener noreferrer');
        await expect(a).toHaveAttribute('href', /^https?:\/\//);
      }
      // Nothing makes the page scroll sideways.
      const body = dialog.locator('.details-body');
      expect(
        await body.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}

test('a hostile description runs nothing and stays inside the dialog', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const dialog = await open(page, HOSTILE);
  const md = dialog.locator('.markdown');
  await expect(md.locator('details').first()).toBeVisible();
  expect(
    await page.evaluate(() => (window as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  expect(requests.filter((u) => u.includes('evil.example'))).toEqual([]);
  await expect(md.locator('script, iframe, svg, form, style')).toHaveCount(0);
  await expect(md.locator('[onclick], [style]')).toHaveCount(0);
  await expect(md.locator('a[href^="javascript:"]')).toHaveCount(0);
  // Everything it opened is closed inside the description.
  const outside = await page.evaluate(() => {
    const el = document.querySelector('dialog .markdown');
    const rect = el?.getBoundingClientRect();
    return rect ? rect.right <= window.innerWidth + 1 : false;
  });
  expect(outside).toBe(true);
  await expect(
    dialog.getByRole('button', { name: 'Close' }).first(),
  ).toBeVisible();
});
