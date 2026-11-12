import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A description that scrolls is reachable by keyboard (#3454): without a tab
// stop a keyboard user can't read past the first screen of it. axe reports
// scrollable-region-focusable on .details-body when nothing inside it takes
// focus, which is the case for a plain-text description.

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

const paragraphs = (lead = '') =>
  Array.from(
    { length: 60 },
    (_, i) => `${lead}Paragraph ${i + 1} of a long description.`,
  ).join('\n\n');

const PLAIN = paragraphs();
const LINKED = `See [the design](https://example.com/design).\n\n${paragraphs()}`;
const CODE = `\`\`\`\nconst x = 1;\n\`\`\`\n\n${paragraphs()}`;

function makePR(number = 42) {
  const now = new Date().toISOString();
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: now,
    updatedAt: now,
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
  };
}

function details(text: string) {
  return {
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
  };
}

async function open(page: Page, texts: Record<number, string>, delayMs = 0) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: Object.keys(texts).map((n) => makePR(Number(n))),
        issues: [],
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/details*', async (route) => {
    const n = Number(new URL(route.request().url()).searchParams.get('number'));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(details(texts[n])),
    });
  });
  await page.goto('/pull-requests.html');
}

const trigger = (page: Page, n = 42) =>
  page.getByRole('button', { name: new RegExp(`^#${n} `) });
const dialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const bodyOf = (page: Page) => dialog(page).locator('.details-body');

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

// The elements Tab visits inside the dialog, in order, until it leaves.
async function tabOrder(page: Page) {
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a ? `${a.tagName}.${a.className}` : '';
    });
    if (seen.includes(id)) break;
    seen.push(id);
    await page.keyboard.press('Tab');
  }
  return seen;
}

const sizes = [
  { width: 320, height: 500 },
  { width: 1280, height: 900 },
];

for (const scheme of ['light', 'dark'] as const) {
  for (const size of sizes) {
    const where = `${size.width}x${size.height} in ${scheme}`;

    test(`a plain-text description is a named tab stop that scrolls with the keys at ${where}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(size);
      await open(page, { 42: PLAIN });
      await trigger(page).click();
      const body = bodyOf(page);
      await expect(body.locator('.markdown')).toBeVisible();
      expect(
        await body.evaluate((el) => el.scrollHeight > el.clientHeight),
      ).toBe(true);
      await expect(body).toHaveAttribute('tabindex', '0');
      await expect(body).toHaveAccessibleName('Description');

      let reached = false;
      for (let i = 0; i < 12 && !reached; i++) {
        await page.keyboard.press('Tab');
        reached = await body.evaluate((el) => el === document.activeElement);
      }
      expect(reached).toBe(true);
      await expect(body).not.toHaveCSS('outline-style', 'none');

      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() => body.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
      const afterArrow = await body.evaluate((el) => el.scrollTop);
      await page.keyboard.press('PageDown');
      await expect
        .poll(() => body.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(afterArrow);
      await axe(page);
    });

    for (const [name, text] of [
      ['linked', LINKED],
      ['code', CODE],
    ] as const) {
      test(`a ${name} description is not an extra tab stop and has no axe violation at ${where}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize(size);
        await open(page, { 42: text });
        await trigger(page).click();
        const body = bodyOf(page);
        await expect(body.locator('.markdown')).toBeVisible();
        expect(
          await body.evaluate((el) => el.scrollHeight > el.clientHeight),
        ).toBe(true);
        await expect(body).not.toHaveAttribute('tabindex', /.*/);
        await expect(body).not.toHaveAttribute('aria-label', /.*/);
        const order = await tabOrder(page);
        expect(order.some((s) => s.includes('details-body'))).toBe(false);
        await axe(page);
      });
    }
  }
}

test('a description that fits is not a tab stop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { 42: 'Short.' });
  await trigger(page).click();
  await expect(bodyOf(page).locator('.markdown')).toBeVisible();
  await expect(bodyOf(page)).not.toHaveAttribute('tabindex', /.*/);
});

test('the tab stop arrives with a slow description', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 500 });
  await open(page, { 42: PLAIN }, 400);
  await trigger(page).click();
  await expect(bodyOf(page)).not.toHaveAttribute('tabindex', /.*/);
  await expect(bodyOf(page).locator('.markdown')).toBeVisible();
  await expect(bodyOf(page)).toHaveAttribute('tabindex', '0');
});

test('the tab stop follows the pull request the dialog is opened for', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 500 });
  await open(page, { 42: PLAIN, 43: LINKED });
  await trigger(page, 42).click();
  await expect(bodyOf(page)).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await trigger(page, 43).click();
  await expect(dialog(page).getByText('See')).toBeVisible();
  await expect(bodyOf(page)).not.toHaveAttribute('tabindex', /.*/);
});
