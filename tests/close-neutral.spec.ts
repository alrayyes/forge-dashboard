import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1223: Close is a reversible "give up on this pull request", so on the row
// it is a neutral button, not green (it read as the affirmative) and not red
// (it isn't destructive). It names the object, "Close pull request", and only
// the confirm step carries the warning tone.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `close-neutral-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Close Neutral');
}

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

function mockDashboard(page: Page, pr: Record<string, unknown>) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pr],
        issues: [],
      }),
    }),
  );
}

const row = (page: Page) => page.locator('#pr-rows .row').first();
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// The Close button wherever it sits: direct on a lone-action row, or inside
// More actions.
async function closeButton(page: Page): Promise<Locator> {
  const more = row(page).getByRole('button', { name: 'More actions' });
  if ((await more.count()) > 0) await more.click();
  return row(page).getByRole('button', {
    name: 'Close pull request',
    exact: true,
  });
}

const background = (el: Locator) =>
  el.evaluate((node) => getComputedStyle(node).backgroundColor);

// A design token's resolved colour, read off a probe so the test compares
// against the page's own palette and not a hard-coded hex.
async function token(page: Page, name: string) {
  return page.evaluate((n) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = `var(${n})`;
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }, name);
}

test.describe('Close is neutral, and says what it closes (#1223)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    // The live stream would push the server's own, newer snapshot over the
    // mock, and the page drops the older one as stale.
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
  });

  test('on a pull request with nothing to merge it is not green, and looks like Close elsewhere', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', empty: true }),
    );
    await page.reload();
    const empty = await closeButton(page);
    await expect(empty).not.toHaveClass(/suggested/);
    const emptyBg = await background(empty);
    expect(emptyBg).not.toBe(await token(page, '--good-bg'));
    expect(emptyBg).not.toBe(await token(page, '--critical-bg'));

    await mockDashboard(
      page,
      makePR({ mergeStatus: 'blocked', ci: 'failure' }),
    );
    await page.reload();
    const other = await closeButton(page);
    expect(await background(other)).toBe(emptyBg);
  });

  test('it is not red until the confirm step', async ({ page }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'blocked', ci: 'failure' }),
    );
    await page.reload();
    const close = await closeButton(page);
    expect(await background(close)).not.toBe(
      await token(page, '--critical-bg'),
    );
  });

  test('the button and its confirm name the object, and the confirm carries the warning tone', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'blocked', ci: 'failure' }),
    );
    await page.reload();
    const close = await closeButton(page);
    await expect(close).toHaveText('Close pull request');
    await expect(close).toHaveAccessibleName('Close pull request');

    await close.click();
    const confirm = row(page).getByRole('button', {
      name: 'Confirm close pull request?',
    });
    await expect(confirm).toBeVisible();
    expect(await background(confirm)).toBe(await token(page, '--warning-bg'));
    await expect(
      row(page).getByRole('button', { name: 'Cancel' }),
    ).toBeVisible();
  });

  for (const theme of ['light', 'dark']) {
    test(`has no axe-core violations with Close and its confirm showing, ${theme}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await context.addCookies([
        { name: 'forge-board-theme', value: theme, url: baseURL ?? '' },
      ]);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await mockDashboard(
        page,
        makePR({ mergeStatus: 'mergeable', empty: true }),
      );
      await page.reload();
      const close = await closeButton(page);
      expect(
        (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations,
      ).toEqual([]);

      await close.click();
      await expect(
        row(page).getByRole('button', { name: 'Confirm close pull request?' }),
      ).toBeVisible();
      expect(
        (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations,
      ).toEqual([]);
    });
  }
});
