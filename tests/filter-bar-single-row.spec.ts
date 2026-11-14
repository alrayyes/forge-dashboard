import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// With the filters at one row, or none, the sort and grouping selects are
// disabled with a reason (the controls stay, #3866) and the label filter
// goes, unless it holds a pick (#3886). The decisions are unit-tested in
// single-row-controls.test.ts; this is the wiring.
// https://github.com/alrayyes/forge-dashboard/issues/3886

function issue(number: number, forge: 'github' | 'forgejo') {
  return {
    forge,
    repo: forge === 'github' ? 'acme/app' : 'acme/tool',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: 'sam',
    labels: [
      { name: 'bug', color: 'd73a4a' },
      { name: `area-${number}`, color: 'ededed' },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
  };
}

// One forgejo issue, three github ones.
const ISSUES = [
  issue(1, 'github'),
  issue(2, 'github'),
  issue(3, 'github'),
  issue(4, 'forgejo'),
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
          { forge: 'github', reachable: true, repoCount: 1 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests: [],
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/issues.html');
  await expect(page.locator('#issue-rows > .row').first()).toBeVisible();
}

const sort = (page: Page) => page.locator('#pr-sort-select');
const group = (page: Page) => page.locator('#shared-group-select');
const labels = (page: Page) =>
  page.locator('#shared-label-filter-button').first();
const pill = (page: Page, name: string) =>
  page
    .locator('.filter-bar')
    .getByRole('button', { name, exact: true })
    .first();
const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

test.describe('filter bar over one row (#3886)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('AC1: many rows offer sort, grouping and labels', async ({ page }) => {
    await open(page);
    await expect(page.locator('#issue-rows > .row')).toHaveCount(4);
    await expect(sort(page)).toHaveAccessibleDescription('');
    await expect(group(page)).toHaveAccessibleDescription('');
    await expect(sort(page)).toBeEnabled();
    await expect(group(page)).toBeEnabled();
    await expect(labels(page)).toBeVisible();
  });

  test('AC1: one row disables sort and grouping with a reason', async ({
    page,
  }) => {
    await open(page);
    await pill(page, 'Forgejo').click();
    await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    await expect(sort(page)).toBeDisabled();
    await expect(group(page)).toBeDisabled();
    await expect(sort(page)).toHaveAccessibleDescription(/two or more rows/i);
    await expect(group(page)).toHaveAccessibleDescription(/two or more rows/i);
    await expect(page.locator('#list-controls-note')).toBeVisible();
    await expect(sort(page)).toBeVisible();
    await expect(group(page)).toBeVisible();
  });

  test('a chosen grouping stays enabled and undescribed over one row', async ({
    page,
  }) => {
    await open(page);
    await group(page).selectOption('repo');
    await pill(page, 'Forgejo').click();
    await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    await expect(group(page)).toBeEnabled();
    await expect(group(page)).toHaveAccessibleDescription('');
    await expect(sort(page)).toBeDisabled();
    await expect(sort(page)).toHaveAccessibleDescription(
      'Sorting needs two or more rows.',
    );
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`a disabled select is drawn dimmed with a blocked cursor in ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      const look = () =>
        sort(page).evaluate((el) => {
          const c = getComputedStyle(el);
          return { color: c.color, cursor: c.cursor };
        });
      const enabled = await look();
      await pill(page, 'Forgejo').click();
      await expect(sort(page)).toBeDisabled();
      const disabled = await look();
      expect(disabled.color).not.toBe(enabled.color);
      expect(disabled.cursor).toBe('not-allowed');
      expect(enabled.cursor).not.toBe('not-allowed');
    });
  }

  test('AC2: one row hides the label filter when no label is picked', async ({
    page,
  }) => {
    await open(page);
    await pill(page, 'Forgejo').click();
    await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    await expect(labels(page)).toBeHidden();
  });

  test('AC2: a picked label keeps its filter so it can be cleared', async ({
    page,
  }) => {
    await open(page);
    await labels(page).click();
    await page.getByLabel('area-1', { exact: true }).check();
    await page.keyboard.press('Escape');
    await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    await expect(labels(page)).toBeVisible();
  });

  test('AC3: clearing the filter restores the controls and a chosen sort', async ({
    page,
  }) => {
    await open(page);
    await sort(page).selectOption('created');
    await pill(page, 'Forgejo').click();
    await expect(sort(page)).toBeDisabled();
    await expect(sort(page)).toHaveValue('created');
    await page.locator('#clear-filters-button').click();
    await expect(page.locator('#issue-rows > .row')).toHaveCount(4);
    await expect(sort(page)).toBeEnabled();
    await expect(sort(page)).toHaveValue('created');
    await expect(group(page)).toBeEnabled();
    await expect(labels(page)).toBeVisible();
  });

  test('AC4: focus stays on the pill that narrowed the list', async ({
    page,
  }) => {
    await open(page);
    await pill(page, 'Forgejo').click();
    await expect(sort(page)).toBeDisabled();
    await expect(pill(page, 'Forgejo')).toBeFocused();
  });

  for (const [name, select] of [
    ['sort', sort],
    ['group', group],
  ] as const) {
    test(`AC4: a focused ${name} that disables hands focus to the All pill`, async ({
      page,
    }) => {
      await open(page);
      await select(page).focus();
      await page.evaluate(() => {
        // The list narrows while the select holds focus, as a refresh can do.
        document.querySelector<HTMLElement>('[data-pill="forgejo"]')?.click();
      });
      await expect(select(page)).toBeDisabled();
      await expect(
        page
          .locator('.filter-bar .quick-pills .quick-pill[data-pill="all"]')
          .first(),
      ).toBeFocused();
    });
  }

  test('AC4: the change is not announced as an alert', async ({ page }) => {
    await open(page);
    await pill(page, 'Forgejo').click();
    await expect(sort(page)).toBeDisabled();
    await expect(page.locator('.filter-bar [role="alert"]')).toHaveCount(0);
  });

  test('AC5: zero rows behave like one', async ({ page }) => {
    await open(page);
    // Text in the box keeps it drawn over one row, so it can be changed.
    await page.locator('#title-filter').fill('Issue');
    await pill(page, 'Forgejo').click();
    await page.locator('#title-filter').fill('no such issue');
    await expect(page.locator('#issue-rows > .row')).toHaveCount(0);
    await expect(sort(page)).toBeDisabled();
    await expect(group(page)).toBeDisabled();
  });

  for (const state of ['many', 'one', 'zero'] as const) {
    for (const mode of ['light', 'dark', 'forced-colors'] as const) {
      test(`AC4: axe is clean over ${state} rows in ${mode}`, async ({
        page,
      }) => {
        if (mode === 'forced-colors')
          await page.emulateMedia({ forcedColors: 'active' });
        else await page.emulateMedia({ colorScheme: mode });
        await open(page);
        if (state === 'zero') await page.locator('#title-filter').fill('Issue');
        if (state !== 'many') await pill(page, 'Forgejo').click();
        if (state === 'zero')
          await page.locator('#title-filter').fill('no such issue');
        // Prove the states differ before axe looks, so a page that never
        // reached the single-row state cannot pass for it.
        if (state === 'many') {
          await expect(sort(page)).toBeEnabled();
          await expect(page.locator('#list-controls-note')).toBeHidden();
        } else {
          await expect(sort(page)).toBeDisabled();
          await expect(group(page)).toBeDisabled();
          await expect(page.locator('#list-controls-note')).toBeVisible();
        }
        expect((await axe(page)).violations).toEqual([]);
      });
    }
  }

  test('a disabled select keeps the system disabled colour in forced colors', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page);
    const look = () =>
      sort(page).evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.color = 'GrayText';
        document.body.append(probe);
        const grayText = getComputedStyle(probe).color;
        probe.remove();
        return { color: getComputedStyle(el).color, grayText };
      });
    const enabled = await look();
    await pill(page, 'Forgejo').click();
    await expect(sort(page)).toBeDisabled();
    const disabled = await look();
    expect(disabled.color).toBe(disabled.grayText);
    expect(enabled.color).not.toBe(enabled.grayText);
  });
});

test.describe('the Releases and Bots pages share the rule (#3886)', () => {
  for (const [path, kind, forge] of [
    ['/releases.html', 'release', 'forgejo'],
    ['/bots.html', 'dependency', 'forgejo'],
  ] as const) {
    test(`${path} disables sort and grouping over one row`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      const pr = (number: number, f: 'github' | 'forgejo') => ({
        forge: f,
        repo: f === 'github' ? 'acme/app' : 'acme/tool',
        number,
        title: `Pull request ${number}`,
        url: `https://example.com/pull/${number}`,
        author: 'dependabot[bot]',
        draft: false,
        ci: 'success',
        labels: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date(Date.now() - number * 1000).toISOString(),
        mergeStatus: 'mergeable',
        behind: false,
        kind,
        closesIssues: [],
      });
      const rows = [pr(1, 'github'), pr(2, 'github'), pr(3, forge)];
      await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
      await page.route('**/api/v1/dashboard*', (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [
              { forge: 'github', reachable: true, repoCount: 1 },
              { forge: 'forgejo', reachable: true, repoCount: 1 },
            ],
            pullRequests: rows,
            issues: [],
            repos: [],
            hiddenDrafts: 0,
          }),
        }),
      );
      await page.goto(path);
      await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
      await expect(sort(page)).toBeEnabled();
      await pill(page, 'Forgejo').click();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(sort(page)).toBeDisabled();
      await expect(group(page)).toBeDisabled();
      await expect(sort(page)).toHaveAccessibleDescription(/two or more rows/i);
    });
  }
});

test.describe('filter bar over one row on a phone (#3886)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('the sheet shows disabled selects with their reason', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.locator('dialog#filter-sheet');
    await sheet.getByRole('button', { name: 'Forgejo', exact: true }).click();
    await expect(sheet.locator('#pr-sort-select')).toBeDisabled();
    await expect(sheet.locator('#shared-group-select')).toBeDisabled();
    await expect(sheet.locator('#shared-label-filter-button')).toBeHidden();
    await expect(sheet.locator('#list-controls-note')).toBeVisible();
    await expect(sheet.locator('#pr-sort-select')).toHaveAccessibleDescription(
      /two or more rows/i,
    );
    expect((await axe(page)).violations).toEqual([]);
  });

  test('a focused sort that disables in the open sheet keeps focus in it', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.locator('dialog#filter-sheet');
    await sheet.locator('#pr-sort-select').focus();
    await page.evaluate(() => {
      document
        .querySelector<HTMLElement>('#filter-sheet [data-pill="forgejo"]')
        ?.click();
    });
    await expect(sheet.locator('#pr-sort-select')).toBeDisabled();
    expect(
      await page.evaluate(
        () => !!document.activeElement?.closest('#filter-sheet'),
      ),
    ).toBe(true);
  });

  test('a picked label keeps its filter in the sheet over one row', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.locator('dialog#filter-sheet');
    await sheet.locator('#shared-label-filter-button').click();
    await sheet.getByLabel('area-1', { exact: true }).check();
    await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    await expect(sheet.locator('#shared-label-filter-button')).toBeVisible();
  });
});
