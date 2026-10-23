import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// Three full picks and a long multibyte title together pass what a browser
// keeps in one cookie, and it would drop the whole cookie without a word. The
// page cuts the cookie on purpose and says what it left out.
// https://github.com/alrayyes/forge-dashboard/issues/2619

const names = (prefix: string) =>
  Array.from(
    { length: 20 },
    (_, i) => `${prefix}-${String(i).padStart(2, '0')}-${'x'.repeat(28)}`,
  ).join('\n');

async function open(page: Page, baseURL: string | undefined) {
  const value = JSON.stringify({
    shared: {
      label: names('label'),
      repo: names('repo'),
      author: names('who'),
    },
    rev: 1,
  });
  await page.context().addCookies([
    {
      name: 'forge-board-filters',
      value: encodeURIComponent(value),
      url: baseURL ?? '',
    },
  ]);
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/issues.html');
}

const notice = (page: Page) => page.locator('#filter-cookie-trimmed');

const cookieSize = (page: Page) =>
  page.evaluate(
    () =>
      document.cookie.split('; ').find((c) => c.startsWith('forge-board-'))
        ?.length ?? 0,
  );

const titleBox = (page: Page) =>
  page.getByRole('combobox', { name: 'Filter by title' });

// The notice needs no dismiss button or Escape: it is replaced or removed on
// the next save that fits, and it is a plain paragraph, not a dialog.
async function axeClean(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test('names what a cookie too large for the browser left out', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await expect(page.locator('#issue-rows')).toBeAttached();
  await expect(notice(page)).toHaveCount(0);
  await titleBox(page).fill('漢'.repeat(200));
  await expect(notice(page)).toContainText('the title search');
  await expect(notice(page)).toContainText(
    'saved filters on the server are whole',
  );
  await expect(notice(page)).not.toContainText('label-19');
  const size = await cookieSize(page);
  expect(size).toBeGreaterThan(0);
  expect(size).toBeLessThanOrEqual(3800);
  await axeClean(page);
});

// The page holds each pick to 1000 encoded characters, so three picks reach
// about 3000 bytes and the title search is what pushes the cookie over. The
// cut of a pick itself (the path after the title) is pinned in the unit test,
// where a state past those limits can be written directly.
test('reloads cleanly with the trimmed cookie and the picks still set', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await expect(page.locator('#issue-rows')).toBeAttached();
  await titleBox(page).fill('漢'.repeat(200));
  await expect(notice(page)).toContainText('the title search');
  expect(await cookieSize(page)).toBeLessThanOrEqual(3800);

  await page.reload();
  await expect(page.locator('#issue-rows')).toBeAttached();
  await expect(notice(page)).toHaveCount(0);
  const cookie = await page.evaluate(() => decodeURIComponent(document.cookie));
  expect(cookie).toContain('label-19-');
  expect(cookie).toContain('who-19-');
  expect(await cookieSize(page)).toBeLessThanOrEqual(3800);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the notice fits a 390px screen and passes axe in ${scheme} mode`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, baseURL);
    await expect(page.locator('#issue-rows')).toBeAttached();
    await titleBox(page).fill('漢'.repeat(200));
    await expect(notice(page)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await notice(page).boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await axeClean(page);
  });
}
