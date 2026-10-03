import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #861: stacked pull requests. Each row in a stack carries a chip with its
// place and what it waits for, the members sit together in position order,
// a filter that matches one member keeps the stack and dims the rest, and a
// phone gets a short chip and a thin rule instead of indentation.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `stacked-prs-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Stacks');
}

let clock = Date.now();
function pr(number: number, over: Record<string, unknown>) {
  clock -= 60_000;
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `PR ${number}`,
    url: `https://example.com/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    mergeStatus: 'mergeable',
    labels: [],
    createdAt: new Date(clock).toISOString(),
    updatedAt: new Date(clock).toISOString(),
    behind: false,
    stack: null,
    stackedOn: null,
    stackChildren: [],
    baseBranch: 'main',
    headBranch: `branch-${number}`,
    crossRepository: false,
    ...over,
  };
}

const blockedMerge = (parent: number) => [
  {
    action: 'merge',
    blocked: {
      code: 'stacked',
      message: `Stacked on #${parent}. Merge that one first.`,
      next: `Merge unlocks once #${parent} merges and this pull request is retargeted.`,
    },
  },
  { action: 'close' },
];

// Server order, newest first: the stack's members are scattered on purpose.
const PRS = [
  pr(900, { title: 'Unrelated newest' }),
  pr(839, {
    title: 'Middle of the stack',
    stack: { position: 2, size: 3 },
    stackedOn: { number: 838, url: 'https://example.com/838' },
    stackChildren: [840],
    baseBranch: 'branch-838',
    allowedActions: blockedMerge(838),
  }),
  pr(901, { title: 'Unrelated second' }),
  pr(840, {
    title:
      'Top of the stack with a long title that has to give way first on a phone screen',
    stack: { position: 3, size: 3 },
    stackedOn: { number: 839, url: 'https://example.com/839' },
    baseBranch: 'branch-839',
    allowedActions: blockedMerge(839),
  }),
  pr(838, {
    title: 'Bottom of the stack',
    stack: { position: 1, size: 3 },
    stackChildren: [839],
  }),
];

async function open(page: Page, size = { width: 1280, height: 900 }) {
  await page.setViewportSize(size);
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowBotPrUpdates: false }),
    }),
  );
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: PRS,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.reload();
  await expect(page.locator('#pr-rows .row')).toHaveCount(PRS.length);
}

const rowFor = (page: Page, n: number) =>
  page.locator(`#pr-rows .row[data-pr-key$="#${n}"]`);

test.describe('stacked pull requests (#861)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('a stacked row has a chip with its place and what it waits for; others have none', async ({
    page,
  }) => {
    await open(page);

    await expect(rowFor(page, 838).locator('.stack-chip')).toContainText(
      'Stack 1 of 3',
    );
    await expect(rowFor(page, 838).locator('.stack-wait')).toContainText(
      'merges first',
    );
    await expect(rowFor(page, 839).locator('.stack-chip')).toContainText(
      'Stack 2 of 3',
    );
    await expect(rowFor(page, 839).locator('.stack-wait')).toContainText(
      'waits for #838',
    );
    await expect(rowFor(page, 840).locator('.stack-wait')).toContainText(
      'waits for #839',
    );
    await expect(rowFor(page, 900).locator('.stack-chip')).toHaveCount(0);
    await expect(rowFor(page, 901).locator('.stack-chip')).toHaveCount(0);
  });

  test('the members sit together in position order, at the slot of the first one, in a plain nested list', async ({
    page,
  }) => {
    await open(page);

    const order = await page
      .locator('#pr-rows .row')
      .evaluateAll((rows) =>
        rows.map((r) => (r as HTMLElement).dataset.prKey?.split('#')[1]),
      );
    expect(order).toEqual(['900', '838', '839', '840', '901']);

    const group = page.locator('#pr-rows ul.stack-group');
    await expect(group).toHaveCount(1);
    await expect(group).toHaveAttribute('aria-label', /Stack of 3/);
    await expect(group.locator('> li')).toHaveCount(3);
    await expect(page.locator('#pr-rows [role="tree"]')).toHaveCount(0);
  });

  test("a child says what it targets and shows the server's reason on Merge", async ({
    page,
  }) => {
    await open(page);

    const child = rowFor(page, 839);
    await expect(child.locator('.stack-note')).toContainText(
      "Depends on #838. Targets #838's branch, not main.",
    );
    await expect(child.locator('.stack-note')).toContainText(
      'Auto-merge is unavailable until it is retargeted to main',
    );
    await expect(child).toContainText('Stacked on #838. Merge that one first.');
    await expect(
      child.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');

    await expect(rowFor(page, 838).locator('.stack-note')).toHaveCount(0);
  });

  test('a filter that matches one member keeps the whole stack and dims the others', async ({
    page,
  }) => {
    await open(page);

    await page
      .getByRole('combobox', { name: 'Filter by title' })
      .fill('Middle of');

    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
    await expect(rowFor(page, 900)).toHaveCount(0);
    await expect(rowFor(page, 839)).not.toHaveClass(/stack-dim/);
    await expect(rowFor(page, 838)).toHaveClass(/stack-dim/);
    await expect(rowFor(page, 840)).toHaveClass(/stack-dim/);
    await expect(rowFor(page, 838)).toContainText("Doesn't match the filters");
  });

  test('tapping the chip lists the stack', async ({ page }) => {
    await open(page);

    const chip = rowFor(page, 839).locator('.stack-chip');
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await chip.click();

    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    const members = rowFor(page, 839).locator('.stack-members li');
    await expect(members).toHaveCount(3);
    await expect(members.nth(0)).toContainText('#838');
    await expect(members.nth(1)).toContainText('this one');
    await expect(members.nth(2)).toContainText('#840');
  });

  test('on a phone the chip is short, the dependency is on a second line, the title gives way and a rule replaces indentation', async ({
    page,
  }) => {
    await open(page, { width: 390, height: 844 });

    const chip = rowFor(page, 840).locator('.stack-chip');
    const wait = rowFor(page, 840).locator('.stack-wait');
    const chipBox = await chip.boundingBox();
    const waitBox = await wait.boundingBox();
    expect(chipBox?.width ?? 999).toBeLessThan(140);
    expect(waitBox?.y ?? 0).toBeGreaterThan((chipBox?.y ?? 0) + 8);

    const rule = await rowFor(page, 840).evaluate((el) => {
      const s = getComputedStyle(el);
      return { left: s.borderLeftWidth, margin: s.marginLeft };
    });
    expect(rule.left).toBe('2px');
    expect(rule.margin).toBe('0px');

    const title = rowFor(page, 840).locator('.title-text');
    expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
      true,
    );
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  for (const [name, size] of [
    ['desktop', { width: 1280, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ] as const) {
    test(`a stacked list has no axe violations at ${name} width`, async ({
      page,
    }) => {
      await open(page, size);
      await rowFor(page, 839).locator('.stack-chip').click();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
