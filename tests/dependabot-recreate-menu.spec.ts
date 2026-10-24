import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import {
  actionsFooter,
  closeActionsDialog,
  openActionsDialog,
} from './actions-dialog-helper';
import { test } from './server-fixture';

// The Bots page row draws Dependabot's Rebase as the main button of a split
// button, with Recreate in a menu behind a chevron. Recreate discards edits, so
// it goes through the confirm step. The two commands lock each other while
// either is pending, and the reason names the pending one.

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

type Mock = Record<string, unknown>;

function makePR(overrides: Mock = {}): Mock {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Bump some-package from 1.0.0 to 1.0.1',
    url: 'https://example.com/42',
    author: 'dependabot',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    ...overrides,
  };
}

function pendingRequest(action: 'rebase' | 'recreate') {
  const now = Date.now();
  return {
    bot: 'dependabot',
    action,
    phase: 'queued',
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
  };
}

// What the server answers while a request is pending: neither command, since
// Dependabot has no command to withdraw one. The wait chip says what the row
// is waiting on.
const PENDING_ACTIONS = [{ action: 'close' }];

function mockDashboard(page: Page, pr: Mock, forgeExtra: Mock = {}) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [
          { forge: 'github', reachable: true, repoCount: 1, ...forgeExtra },
        ],
        pullRequests: [pr],
        issues: [],
      }),
    }),
  );
}

async function recordPosts(page: Page) {
  const posts: Mock[] = [];
  await page.route('**/api/pull-requests/dependabot-action', (route: Route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  return posts;
}

const rowOf = (page: Page) => page.locator('#pr-rows .row').first();
const toggleOf = (row: Locator) =>
  row.getByRole('button', { name: 'More Dependabot actions' });

async function openMenu(row: Locator) {
  await toggleOf(row).click();
  return row.getByRole('menu', { name: 'More Dependabot actions' });
}

test.describe('Dependabot Recreate beside Rebase on the Bots page row', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
    await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowBotPrUpdates: false }),
      }),
    );
  });

  test('Rebase is the main button and a chevron opens a menu with Recreate', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await page.goto('/bots.html');
    const row = rowOf(page);

    await expect(
      row.getByRole('button', { name: 'Dependabot: Rebase' }),
    ).toBeVisible();
    const toggle = toggleOf(row);
    await expect(toggle).toHaveAttribute('aria-haspopup', 'menu');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(
      row.getByRole('menuitem', { name: 'Dependabot: Recreate' }),
    ).toHaveCount(0);

    const menu = await openMenu(row);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(
      menu.getByRole('menuitem', { name: 'Dependabot: Recreate' }),
    ).toBeVisible();
  });

  test('choosing Recreate asks first, and only confirming posts the command', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    const posts = await recordPosts(page);
    await page.goto('/bots.html');
    const row = rowOf(page);

    const menu = await openMenu(row);
    await menu.getByRole('menuitem', { name: 'Dependabot: Recreate' }).click();

    const confirm = row.getByRole('button', { name: 'Confirm recreate?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toBeFocused();
    await expect(confirm).toHaveAccessibleDescription(/discards any edits/i);
    await expect(row.getByText(/discards any edits/i)).toBeVisible();
    expect(posts).toEqual([]);

    await confirm.click();
    await expect
      .poll(() => posts)
      .toEqual([
        {
          forge: 'github',
          fullName: 'alrayyes/forge-dashboard',
          number: 42,
          action: 'recreate',
        },
      ]);
  });

  test('Escape and a click elsewhere cancel the confirm step, and nothing is posted', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    const posts = await recordPosts(page);
    await page.goto('/bots.html');
    const row = rowOf(page);
    const arm = async () => {
      const menu = await openMenu(row);
      await menu
        .getByRole('menuitem', { name: 'Dependabot: Recreate' })
        .click();
      await expect(
        row.getByRole('button', { name: 'Confirm recreate?' }),
      ).toBeVisible();
    };

    await arm();
    await page.keyboard.press('Escape');
    await expect(
      row.getByRole('button', { name: 'Confirm recreate?' }),
    ).toHaveCount(0);
    await expect(toggleOf(row)).toBeFocused();

    await arm();
    await page.locator('h1').first().click();
    await expect(
      row.getByRole('button', { name: 'Confirm recreate?' }),
    ).toHaveCount(0);
    expect(posts).toEqual([]);
  });

  test('Escape and a click elsewhere close the open menu', async ({ page }) => {
    await mockDashboard(page, makePR());
    await page.goto('/bots.html');
    const row = rowOf(page);

    await openMenu(row);
    await page.keyboard.press('Escape');
    await expect(row.getByRole('menu')).toHaveCount(0);
    await expect(toggleOf(row)).toBeFocused();

    await openMenu(row);
    await page.locator('h1').first().click();
    await expect(row.getByRole('menu')).toHaveCount(0);
  });

  test('a queued Recreate reads Recreate requested and the other command is not drawn', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await recordPosts(page);
    await page.goto('/bots.html');
    const row = rowOf(page);

    const menu = await openMenu(row);
    await menu.getByRole('menuitem', { name: 'Dependabot: Recreate' }).click();
    await row.getByRole('button', { name: 'Confirm recreate?' }).click();

    await expect(
      row.getByRole('button', { name: /Dependabot: (Rebase|Recreate)/ }),
    ).toHaveCount(0);
    const footer = await openFooter(row);
    await expect(
      footer.getByRole('button', { name: 'Recreate requested' }),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(
      footer.getByRole('button', { name: /Dependabot: (Rebase|Recreate)/ }),
    ).toHaveCount(0);
    await expect(footer).not.toContainText('is pending on this pull request');
  });

  test('keyboard: confirming Recreate in the row keeps the focus on the row', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await recordPosts(page);
    await page.goto('/bots.html');
    const row = rowOf(page);

    await toggleOf(row).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(
      row.getByRole('button', { name: 'Confirm recreate?' }),
    ).toBeFocused();
    // An Enter straight after the confirm appears is ignored on purpose, so
    // press until the guard lets one through. The menu is closed by then and
    // the row keeps only its wait chip, so the focus has to land on the row.
    await expect(async () => {
      await page.keyboard.press('Enter');
      await expect(
        row.getByRole('button', { name: 'Confirm recreate?' }),
      ).toHaveCount(0, { timeout: 300 });
    }).toPass();
    await expect(row.locator('[id^="details-trigger-"]')).toBeFocused();
  });

  test('a queued Rebase leaves neither Dependabot command in the menu', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    await recordPosts(page);
    await page.goto('/bots.html');
    const row = rowOf(page);

    await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();

    await expect(
      row.getByRole('button', { name: /Dependabot: (Rebase|Recreate)/ }),
    ).toHaveCount(0);
    await expect(toggleOf(row)).toHaveCount(0);
  });

  for (const pending of ['recreate', 'rebase'] as const) {
    test(`a ${pending} the server already has leaves neither command in the row, the menu and the pop-up`, async ({
      page,
    }) => {
      await mockDashboard(
        page,
        makePR({
          botRequest: pendingRequest(pending),
          allowedActions: PENDING_ACTIONS,
        }),
      );
      await page.goto('/bots.html');
      const row = rowOf(page);
      const commands = /Dependabot: (Rebase|Recreate)/;

      await expect(row.getByRole('button', { name: commands })).toHaveCount(0);
      await expect(toggleOf(row)).toHaveCount(0);

      const footer = await openFooter(row);
      await expect(footer.getByRole('button', { name: commands })).toHaveCount(
        0,
      );
      await expect(footer).not.toContainText('is pending on this pull request');
    });
  }

  test('a credential Dependabot refuses locks both entries with the same reason', async ({
    page,
  }) => {
    const reason = 'GitHub Apps cannot comment commands to Dependabot.';
    await mockDashboard(page, makePR(), { dependabotCommandsBlocked: reason });
    await page.goto('/bots.html');
    const row = rowOf(page);

    await expect(
      row.getByRole('button', { name: 'Dependabot: Rebase' }),
    ).toHaveAttribute('aria-disabled', 'true');
    const menu = await openMenu(row);
    await expect(
      menu.getByRole('menuitem', { name: 'Dependabot: Recreate' }),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(menu).toContainText(reason);
  });

  test('the pop-up footer keeps Recreate, behind the same confirm step', async ({
    page,
  }) => {
    await mockDashboard(page, makePR());
    const posts = await recordPosts(page);
    await page.goto('/bots.html');

    const footer = await openFooter(rowOf(page));
    await footer.getByRole('button', { name: 'Dependabot: Recreate' }).click();
    expect(posts).toEqual([]);
    await footer.getByRole('button', { name: 'Confirm recreate?' }).click();
    await expect.poll(() => posts).toMatchObject([{ action: 'recreate' }]);
  });

  test('fits a 360px screen with the menu and the confirm step open, with no axe violations', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await mockDashboard(page, makePR());
    await page.goto('/bots.html');
    const row = rowOf(page);
    const noOverflow = async () =>
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
    const scan = async () =>
      expect(
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
      ).toEqual([]);

    await expect(toggleOf(row)).toBeVisible();
    await noOverflow();
    await scan();

    const menu = await openMenu(row);
    await expect(
      menu.getByRole('menuitem', { name: 'Dependabot: Recreate' }),
    ).toBeVisible();
    await noOverflow();
    await scan();

    await menu.getByRole('menuitem', { name: 'Dependabot: Recreate' }).click();
    const confirm = row.getByRole('button', { name: 'Confirm recreate?' });
    await expect(confirm).toBeVisible();
    // The confirm button fades in; scan once it has.
    await expect(confirm).toHaveCSS('opacity', '1');
    await noOverflow();
    await scan();
  });
});

async function openFooter(row: Locator) {
  return actionsFooter(await openActionsDialog(row));
}
