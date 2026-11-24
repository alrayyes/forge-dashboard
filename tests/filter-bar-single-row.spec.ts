import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// With the filters at one row, or none, the sort and grouping selects and
// the Created and Updated filters go, and so does the label filter unless it
// holds a pick (#3886, #4680). A control that is set stays, so it can be
// undone. The decisions are unit-tested in single-row-controls.test.ts; this
// is the wiring.
// https://github.com/alrayyes/forge-dashboard/issues/4680

function issue(number: number, forge: 'github' | 'forgejo') {
  return {
    forge,
    repo: forge === 'github' ? 'acme/app' : 'acme/tool',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: forge === 'github' ? 'sam' : 'kim',
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

async function open(page: Page, issues = ISSUES) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github'), forgeHealth('forgejo')],
        pullRequests: [],
        issues,
        openIssueCount: issues.length,
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
const created = (page: Page) => page.locator('#created-filter');
const updated = (page: Page) => page.locator('#updated-filter');
const note = (page: Page) => page.locator('#list-controls-note');
const labels = (page: Page) =>
  page.locator('#shared-label-filter-button').first();
const pill = (page: Page, name: string) =>
  page
    .locator('.filter-bar')
    .getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) })
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
    await expect(sort(page)).toBeVisible();
    await expect(group(page)).toBeVisible();
    await expect(created(page)).toBeVisible();
    await expect(updated(page)).toBeVisible();
    await expect(labels(page)).toBeVisible();
    await expect(note(page)).toHaveCount(0);
  });

  test('AC1: one row drops sort, grouping, the dates and the note', async ({
    page,
  }) => {
    await open(page);
    await pill(page, 'Forgejo').click();
    await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    await expect(sort(page)).toBeHidden();
    await expect(group(page)).toBeHidden();
    await expect(created(page)).toBeHidden();
    await expect(updated(page)).toBeHidden();
    await expect(note(page)).toHaveCount(0);
    await expect(
      page.getByRole('combobox', { name: /Sort|Group|created|updated/i }),
    ).toHaveCount(0);
    // The pill that narrowed the list is the way back, and stays.
    await expect(pill(page, 'Forgejo')).toBeVisible();
  });

  test('a set Created filter stays over one row and can be undone', async ({
    page,
  }) => {
    await open(page);
    await created(page).selectOption('1440');
    await pill(page, 'Forgejo').click();
    await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    await expect(created(page)).toBeVisible();
    await expect(updated(page)).toBeHidden();
    await expect(sort(page)).toBeHidden();
    await created(page).selectOption('');
    await expect(created(page)).toBeHidden();
  });

  test('a saved grouping is kept, and the one row renders flat', async ({
    page,
  }) => {
    await open(page);
    await group(page).selectOption('repo');
    await expect(page.locator('#issue-rows .group-heading')).not.toHaveCount(0);
    await pill(page, 'Forgejo').click();
    await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    await expect(group(page)).toBeHidden();
    await expect(page.locator('#issue-rows .group-heading')).toHaveCount(0);
    await pill(page, 'All').click();
    await expect(page.locator('#issue-rows > .row')).toHaveCount(4);
    await expect(group(page)).toHaveValue('repo');
    await expect(page.locator('#issue-rows .group-heading')).not.toHaveCount(0);
  });

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
    await expect(sort(page)).toBeHidden();
    await page.locator('#clear-filters-button').click();
    await expect(page.locator('#issue-rows > .row')).toHaveCount(4);
    await expect(sort(page)).toBeVisible();
    await expect(sort(page)).toHaveValue('created');
    await expect(group(page)).toBeVisible();
    await expect(created(page)).toBeVisible();
    await expect(labels(page)).toBeVisible();
  });

  test('AC4: focus stays on the pill that narrowed the list', async ({
    page,
  }) => {
    await open(page);
    await pill(page, 'Forgejo').click();
    await expect(sort(page)).toBeHidden();
    await expect(pill(page, 'Forgejo')).toBeFocused();
  });

  for (const [name, select] of [
    ['sort', sort],
    ['group', group],
  ] as const) {
    test(`AC4: a focused ${name} that hides hands focus to the All pill`, async ({
      page,
    }) => {
      await open(page);
      await select(page).focus();
      await page.evaluate(() => {
        // The list narrows while the select holds focus, as a refresh can do.
        document.querySelector<HTMLElement>('[data-pill="forgejo"]')?.click();
      });
      await expect(select(page)).toBeHidden();
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
    await expect(sort(page)).toBeHidden();
    await expect(page.locator('.filter-bar [role="alert"]')).toHaveCount(0);
  });

  test('AC5: zero rows behave like one', async ({ page }) => {
    await open(page);
    // Text in the box keeps it drawn over one row, so it can be changed.
    await page.locator('#title-filter').fill('Issue');
    await pill(page, 'Forgejo').click();
    await page.locator('#title-filter').fill('no such issue');
    await expect(page.locator('#issue-rows > .row')).toHaveCount(0);
    await expect(sort(page)).toBeHidden();
    await expect(group(page)).toBeHidden();
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
          await expect(sort(page)).toBeVisible();
        } else {
          await expect(sort(page)).toBeHidden();
          await expect(group(page)).toBeHidden();
        }
        expect((await axe(page)).violations).toEqual([]);
      });
    }
  }
});

test.describe('the Releases and Bots pages share the rule (#3886)', () => {
  for (const [path, kind, forge] of [
    ['/releases.html', 'release', 'forgejo'],
    ['/bots.html', 'dependency', 'forgejo'],
  ] as const) {
    test(`${path} drops sort and grouping over one row`, async ({ page }) => {
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
            forges: [forgeHealth('github'), forgeHealth('forgejo')],
            pullRequests: rows,
            issues: [],
            repos: [],
            hiddenDrafts: 0,
          }),
        }),
      );
      await page.goto(path);
      await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
      await expect(sort(page)).toBeVisible();
      await pill(page, 'Forgejo').click();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await expect(sort(page)).toBeHidden();
      await expect(group(page)).toBeHidden();
    });
  }
});

const REPOS = [
  issue(1, 'github'),
  issue(2, 'github'),
  { ...issue(3, 'github'), repo: 'acme/lib' },
  issue(4, 'forgejo'),
];

test.describe('each option is offered only where it makes a difference (#4680)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  const offered = (page: Page, select: typeof sort) =>
    select(page).evaluate((el) =>
      [...(el as HTMLSelectElement).options]
        .filter((o) => !o.hidden && !o.disabled)
        .map((o) => o.value),
    );

  test('several rows from one repo hide Group and the Repository sort', async ({
    page,
  }) => {
    await open(page, [
      issue(1, 'github'),
      issue(2, 'github'),
      issue(3, 'github'),
    ]);
    await expect(page.locator('#issue-rows > .row')).toHaveCount(3);
    await expect(group(page)).toBeHidden();
    await expect(sort(page)).toBeVisible();
    expect(await offered(page, sort)).toEqual(['', 'created']);
  });

  test('two repos on one forge offer grouping by repository only', async ({
    page,
  }) => {
    await open(page, REPOS.slice(0, 3));
    await expect(group(page)).toBeVisible();
    expect(await offered(page, group)).toEqual(['', 'repo']);
    expect(await offered(page, sort)).toEqual(['', 'created', 'repo']);
  });

  test('two forges offer both', async ({ page }) => {
    await open(page, REPOS);
    expect(await offered(page, group)).toEqual(['', 'repo', 'forge']);
  });

  test('a repo filter that leaves one repo hides Group, Clear brings it back', async ({
    page,
  }) => {
    await open(page, REPOS.slice(0, 3));
    await page.locator('#shared-repo-filter-button').first().click();
    await page
      .getByRole('checkbox', { name: 'acme/app', exact: true })
      .first()
      .check();
    await page.keyboard.press('Escape');
    await expect(page.locator('#issue-rows > .row')).toHaveCount(2);
    await expect(group(page)).toBeHidden();
    await expect(
      page.locator('#shared-repo-filter-button').first(),
    ).toBeVisible();
    await page.locator('#clear-filters-button').click();
    await expect(group(page)).toBeVisible();
  });

  test('axe is clean with the bar trimmed', async ({ page }) => {
    await open(page, [issue(1, 'github'), issue(2, 'github')]);
    await expect(group(page)).toBeHidden();
    expect((await axe(page)).violations).toEqual([]);
  });
});

test.describe('filter bar over one row on a phone (#3886)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('the sheet drops the selects over one row', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.locator('dialog#filter-sheet');
    await sheet.getByRole('button', { name: /^Forgejo( \d+)?$/ }).click();
    await expect(page.locator('#pr-sort-select')).toBeHidden();
    await expect(sheet.locator('#shared-group-select')).toBeHidden();
    await expect(sheet.locator('#created-filter')).toBeHidden();
    await expect(sheet.locator('#shared-label-filter-button')).toBeHidden();
    await expect(sheet.locator('#list-controls-note')).toHaveCount(0);
    expect((await axe(page)).violations).toEqual([]);
  });

  test('a focused group select that hides in the open sheet keeps focus in it', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.locator('dialog#filter-sheet');
    await sheet.locator('#shared-group-select').focus();
    await page.evaluate(() => {
      document
        .querySelector<HTMLElement>('#filter-sheet [data-pill="forgejo"]')
        ?.click();
    });
    await expect(sheet.locator('#shared-group-select')).toBeHidden();
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

// Every pick filter hides over one row unless it holds a pick, on every page
// that draws them. `SharedPicks.draw()` applies `pickFilterVisible` to all
// three, so each one is pinned here (#3943).
// https://github.com/alrayyes/forge-dashboard/issues/3943
const PICKS = [
  { name: 'repo', button: '#shared-repo-filter-button', pick: 'acme/tool' },
  { name: 'author', button: '#shared-author-filter-button', pick: 'kim' },
  { name: 'label', button: '#shared-label-filter-button', pick: 'area-4' },
] as const;

const PAGES = [
  { path: '/issues.html', kind: 'issue', rows: '#issue-rows > .row' },
  { path: '/releases.html', kind: 'release', rows: '#pr-rows > .row' },
  { path: '/bots.html', kind: 'dependency', rows: '#pr-rows > .row' },
] as const;

async function openPage(page: Page, path: string, kind: string) {
  const pr = (number: number, forge: 'github' | 'forgejo') => ({
    ...issue(number, forge),
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    draft: false,
    ci: 'success',
    mergeStatus: 'mergeable',
    behind: false,
    kind,
    closesIssues: [],
  });
  const rows = ISSUES.map((i) => pr(i.number, i.forge));
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github'), forgeHealth('forgejo')],
        pullRequests: kind === 'issue' ? [] : rows,
        issues: kind === 'issue' ? ISSUES : [],
        openIssueCount: kind === 'issue' ? ISSUES.length : 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(path);
}

for (const { path, kind, rows } of PAGES) {
  test.describe(`pick filters over one row on ${path} (#3943)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openPage(page, path, kind);
      await expect(page.locator(rows)).toHaveCount(4);
    });

    for (const { name, button, pick } of PICKS) {
      const control = (page: Page) => page.locator(button).first();

      test(`many rows draw the ${name} filter`, async ({ page }) => {
        await expect(control(page)).toBeVisible();
        expect((await axe(page)).violations).toEqual([]);
      });

      test(`one row hides the ${name} filter when nothing is picked`, async ({
        page,
      }) => {
        await pill(page, 'Forgejo').click();
        await expect(page.locator(rows)).toHaveCount(1);
        await expect(control(page)).toBeHidden();
        expect((await axe(page)).violations).toEqual([]);
      });

      test(`a picked ${name} stays drawn over one row until it is cleared`, async ({
        page,
      }) => {
        const box = control(page)
          .locator('xpath=..')
          .getByRole('checkbox', { name: pick, exact: true });
        await control(page).click();
        await box.check();
        await page.keyboard.press('Escape');
        // The filter's own pick is not in its pool, so it still has choices
        // here. Narrowing with the pill leaves it one row and one choice, so
        // only the held pick keeps it drawn.
        // The repo pick alone leaves one forge and one row, and with one
        // forge the Forge pills are not drawn (#4273).
        if (name !== 'repo') await pill(page, 'Forgejo').click();
        await expect(page.locator(rows)).toHaveCount(1);
        await expect(control(page)).toBeVisible();
        expect((await axe(page)).violations).toEqual([]);
        await control(page).click();
        await box.uncheck();
        await page.keyboard.press('Escape');
        // Clearing the repo pick brings the rows and the Forge pills back, so
        // narrow with the pill to reach one row with nothing picked.
        if (name === 'repo') await pill(page, 'Forgejo').click();
        await expect(page.locator(rows)).toHaveCount(1);
        await expect(control(page)).toBeHidden();
        expect((await axe(page)).violations).toEqual([]);
      });
    }
  });
}
