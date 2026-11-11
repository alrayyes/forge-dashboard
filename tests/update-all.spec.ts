import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { viaActionsDialog } from './actions-dialog-helper';
import { test } from './server-fixture';

// The Pull requests header updates every listed pull request the server says
// can be brought up to date. Who counts and the wording are pinned in
// update-all.test.ts; these cases pin the wiring: the header, the confirm, the
// requests made and a refusal staying on its row.

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Change number ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: true,
    allowedActions: [{ action: 'update_branch' }],
    ...overrides,
  };
}

// Counts the refreshes the page asks for and, once `gate` is set, holds each
// one open until it resolves: a forge that is slow to answer a refresh.
type Reads = { count: number; gate: Promise<void> | null };

async function open(
  page: Page,
  pullRequests: ReturnType<typeof pr>[],
  reads: Reads = { count: 0, gate: null },
) {
  const posts: Record<string, unknown>[] = [];
  const snapshot = () =>
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
      pullRequests,
      issues: [],
      repos: [],
      hiddenDrafts: 0,
    });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard/refresh*', async (route: Route) => {
    reads.count++;
    if (reads.gate) await reads.gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    });
  });
  await page.route('**/api/v1/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    }),
  );
  await page.route('**/api/v1/dashboard?*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    }),
  );
  await page.route('**/api/v1/pull-requests/update-branch', (route: Route) => {
    const body = route.request().postDataJSON();
    posts.push(body);
    if (body.number === 3) {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Conflicts',
          code: 'conflicts',
          message: 'The pull request has conflicts.',
        }),
      });
    }
    return route.fulfill({ status: 204 });
  });
  await page.goto('/pull-requests.html');
  return posts;
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test('Update all updates the ticked rows', async ({ page }) => {
  const posts = await open(page, [
    pr(1),
    pr(2),
    pr(4),
    pr(5, { allowedActions: [] }),
  ]);
  const button = page.getByRole('button', { name: 'Update all (3)' });
  await expect(button).toBeVisible();
  await expect(page.getByText('can be updated.')).toHaveCount(0);
  await expect(chips(page)).toHaveText(['3 ready to update']);

  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Update 3 pull requests?' });
  await expect(dialog.getByRole('checkbox')).toHaveCount(3);
  await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(3);
  await dialog.getByRole('checkbox').nth(2).uncheck();

  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => posts.map((p) => p.number)).toEqual([1, 2]);
  await expect(page.locator('#update-all-status')).toHaveText(
    'Update requested for 2.',
  );
});

test('Update all does not wait on a board refresh between rows', async ({
  page,
}) => {
  const reads: Reads = { count: 0, gate: null };
  let release!: () => void;
  const posts = await open(page, [pr(1), pr(2), pr(4), pr(5)], reads);
  const header = page.getByRole('button', { name: 'Update all (4)' });
  await expect(header).toBeVisible();
  const readsBefore = reads.count;
  reads.gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await header.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Every request goes out and the run ends although no refresh has
  // answered, and the board asks for one refresh, not one per row.
  await expect.poll(() => posts.map((p) => p.number)).toEqual([1, 2, 4, 5]);
  await expect(page.locator('#update-all-status')).toHaveText(
    'Update requested for 4.',
  );
  await expect.poll(() => reads.count - readsBefore).toBe(1);
  release();
});

test('a row Update branch still refreshes the board', async ({ page }) => {
  const reads: Reads = { count: 0, gate: null };
  await open(page, [pr(1)], reads);
  const row = page.locator('#pr-rows .row', { hasText: 'Change number 1' });
  await expect(row).toBeVisible();
  const readsBefore = reads.count;
  await viaActionsDialog(row, (footer) =>
    footer.getByRole('button', { name: 'Update branch' }).click(),
  );
  await expect.poll(() => reads.count - readsBefore).toBe(1);
});

test('the header counts the run while a request is open', async ({ page }) => {
  await open(page, [pr(1), pr(2)]);
  let answer!: () => void;
  const open2 = new Promise<void>((resolve) => {
    answer = resolve;
  });
  // Registered last, so it wins over the open() route for row 2.
  await page.route('**/api/v1/pull-requests/update-branch', async (route) => {
    if (route.request().postDataJSON().number === 2) await open2;
    await route.fulfill({ status: 204 });
  });

  const header = page.getByRole('button', { name: 'Update all (2)' });
  await header.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog).toBeHidden();

  const running = page.getByRole('button', { name: /Updating 1 of 2/ });
  await expect(running).toBeVisible();
  // Focus went back to the header button when the dialog closed.
  await expect(running).toBeFocused();

  answer();
  await expect(page.locator('#update-all-status')).toHaveText(
    'Update requested for 2.',
  );
});

test('a refused update shows its reason on its row', async ({ page }) => {
  const posts = await open(page, [pr(1), pr(3)]);
  await page.getByRole('button', { name: 'Update all (2)' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => posts.length).toBe(2);
  await expect(
    page.locator('#pr-rows .row', { hasText: 'Change number 3' }),
  ).toContainText('The pull request has conflicts.');
  await expect(page.locator('#update-all-status')).toHaveText(
    'Update requested for 1 of 2. 1 failed.',
  );
});

test('Escape on the confirm updates nothing', async ({ page }) => {
  const posts = await open(page, [pr(1)]);
  await page.getByRole('button', { name: 'Update all (1)' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(posts).toEqual([]);
});

test('with nothing to update the button and its line are not shown', async ({
  page,
}) => {
  await open(page, [pr(1, { allowedActions: [] })]);
  await expect(page.locator('.board-head')).toBeVisible();
  await expect(page.locator('.update-all')).toBeHidden();
  await expect(page.getByRole('button', { name: /Update all/ })).toHaveCount(0);
});

test('Update all sits where Rebase all sits on the Bots page', async ({
  page,
}) => {
  await open(page, [pr(1)]);
  const head = await page.locator('.board-head').boundingBox();
  const block = await page.locator('.update-all').boundingBox();
  expect(head).not.toBeNull();
  expect(block).not.toBeNull();
  // Straight under the board header, as the Bots page's block is.
  expect(block!.y).toBeGreaterThanOrEqual(head!.y + head!.height);
  expect(block!.y - (head!.y + head!.height)).toBeLessThan(40);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the confirm fits a phone in ${scheme} and passes axe`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 360, height: 800 });
    await open(page, [pr(1), pr(2)]);
    await page.getByRole('button', { name: 'Update all (2)' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoAxeViolations(page);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
}

// The summary line and its button sit inside the card's own padding (#3246):
// the sentence starts where the heading does, the button ends 18px inside the
// card's right edge, and 12px separates the block from the header rule and
// from the first row, measured to the content (the strip's own padding).
for (const width of [390, 1280]) {
  test(`the Update all block sits inside the card padding at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, [pr(1), pr(2)]);
    const button = page.locator('#update-all-button');
    await expect(button).toBeVisible();
    const m = await page.evaluate(() => {
      const r = (el: Element | null) => el!.getBoundingClientRect();
      const card = document.querySelector('section.board')!;
      const chipList = document.querySelector('.update-all-chips')!;
      const button = document.getElementById('update-all-button')!;
      // The strip's own box, less its padding: the chips and the stacked
      // phone layout move the content, but the insets stay 12px and 18px.
      const block = document.querySelector('.update-all')!;
      const pad = getComputedStyle(block);
      return {
        headingLeft: r(card.querySelector('.board-head h2')).left,
        headBottom: r(card.querySelector('.board-head')).bottom,
        cardInnerRight: r(card).right - card.clientLeft,
        summaryLeft: r(chipList).left,
        buttonRight: r(button).right,
        blockTop: r(block).top + Number.parseFloat(pad.paddingTop),
        blockBottom: r(block).bottom - Number.parseFloat(pad.paddingBottom),
        rowTop: r(document.querySelector('#pr-rows > .row')).top,
        buttonMinHeight: getComputedStyle(button).minHeight,
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
      };
    });
    expect(m.summaryLeft).toBeCloseTo(m.headingLeft, 0);
    expect(m.cardInnerRight - m.buttonRight).toBeCloseTo(18, 0);
    expect(m.blockTop - m.headBottom).toBeCloseTo(12, 0);
    expect(m.rowTop - m.blockBottom).toBeCloseTo(12, 0);
    expect(m.buttonMinHeight).toBe('44px');
    expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
  });
}

// The summary as a status strip (#3277, #3490): one ready chip and the button.
// The page header already counts the listed rows ("12 open", or "Showing 4 of
// 12" under a filter), so the strip says only what is ready.
const chips = (page: Page) => page.locator('.update-all-chips > li');

test('the strip shows the ready count as a chip beside the button', async ({
  page,
}) => {
  await open(page, [pr(1), pr(2), pr(4), pr(5, { allowedActions: [] })]);
  await expect(chips(page)).toHaveText(['3 ready to update']);
  await expect(page.locator('.update-all-headline')).toHaveCount(0);
  await expect(page.getByText('can be updated.')).toHaveCount(0);
  await expect(page.locator('#pr-count')).toHaveText('4 open');
  await expect(
    page.getByRole('button', { name: 'Update all (3)' }),
  ).toBeVisible();
});

test('on a phone the chips keep their words and the button fills the strip', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, [pr(1), pr(2), pr(4), pr(5, { allowedActions: [] })]);
  await expect(chips(page)).toHaveText(['3 ready to update']);
  const m = await page.evaluate(() => {
    const r = (el: Element) => el.getBoundingClientRect();
    const block = document.querySelector('.update-all')!;
    const button = document.getElementById('update-all-button')!;
    const style = getComputedStyle(block);
    return {
      buttonLeft: r(button).left,
      buttonRight: r(button).right,
      buttonHeight: r(button).height,
      left:
        r(block).left + Number.parseFloat(style.paddingLeft) + block.clientLeft,
      right:
        r(block).right -
        Number.parseFloat(style.paddingRight) -
        block.clientLeft,
      chipHeights: [...document.querySelectorAll('.update-all-chips > li')].map(
        (li) => Math.round(r(li).height),
      ),
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    };
  });
  expect(m.buttonLeft).toBeCloseTo(m.left, 0);
  expect(m.buttonRight).toBeCloseTo(m.right, 0);
  expect(m.buttonHeight).toBeGreaterThanOrEqual(44);
  // One line tall: a chip's words never break mid-word.
  expect(Math.max(...m.chipHeights)).toBeLessThan(40);
  expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
});

test('the strip stays through a run and the chips follow it', async ({
  page,
}) => {
  await open(page, [pr(1), pr(2)]);
  let answer!: () => void;
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route('**/api/v1/pull-requests/update-branch', async (route) => {
    if (route.request().postDataJSON().number === 2) await held;
    await route.fulfill({ status: 204 });
  });
  await page.getByRole('button', { name: 'Update all (2)' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Update', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /Updating 1 of 2/ }),
  ).toBeVisible();
  await expect(page.locator('.update-all-chips')).toBeVisible();
  await expect(chips(page)).toHaveText([/^[01] ready to update$/]);
  answer();
  await expect(page.locator('#update-all-status')).toHaveText(
    'Update requested for 2.',
  );
});

test('with nothing to update the chip list is hidden with the strip', async ({
  page,
}) => {
  await open(page, [pr(1, { allowedActions: [] })]);
  await expect(page.locator('.board-head')).toBeVisible();
  await expect(page.locator('.update-all')).toBeHidden();
  await expect(page.locator('.update-all-chips')).toBeHidden();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the strip passes axe in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, [pr(1), pr(2, { allowedActions: [] })]);
    await expect(chips(page)).toHaveText(['1 ready to update']);
    await expectNoAxeViolations(page);
  });
}

test('the header counts the rows and the strip only the ready ones', async ({
  page,
}) => {
  await open(page, [pr(1), pr(2), pr(3, { allowedActions: [] })]);
  await expect(page.locator('#pr-count')).toHaveText('3 open');
  await expect(chips(page)).toHaveText(['2 ready to update']);
});

test('at 320px the chip and the button stack without sideways scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await open(page, [pr(1), pr(2)]);
  const button = page.locator('#update-all-button');
  await expect(button).toBeVisible();
  await expect(chips(page)).toHaveText(['2 ready to update']);
  const m = await page.evaluate(() => ({
    h: document.getElementById('update-all-button')!.getBoundingClientRect()
      .height,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  expect(m.h).toBeGreaterThanOrEqual(44);
  expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
});
