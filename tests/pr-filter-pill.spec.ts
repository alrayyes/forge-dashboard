import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The pull request page draws its Forge and CI groups with the one shared
// filter pill (#4279): 32px high, outlined, accent fill when pressed, a
// visible group label and a count in every pill. On a phone the same pills
// sit in the Filters sheet beside Repository, Author and Label dropdowns that
// each have a visible label, and the footer says how many results it shows. A
// pill's hit area is 44px on a phone while the drawn pill stays 32px (#4611).
// https://github.com/alrayyes/forge-dashboard/issues/4611
// https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html

type Seed = [forge: string, repo: string, author: string, ci: string];

// Three GitHub pull requests (two passing, one failing) and two Forgejo ones
// (one running, one passing), by two authors in three repos, with two labels.
const SEEDS: Seed[] = [
  ['github', 'acme/app', 'ana', 'success'],
  ['github', 'acme/app', 'bo', 'success'],
  ['github', 'acme/lib', 'ana', 'failure'],
  ['forgejo', 'lab/tools', 'bo', 'pending'],
  ['forgejo', 'lab/tools', 'ana', 'success'],
];

async function seed(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github'), forgeHealth('forgejo')],
        pullRequests: SEEDS.map(([forge, repo, author, ci], i) => ({
          forge,
          repo,
          number: i + 1,
          title: `Pull request ${i + 1}`,
          url: `https://example.com/${i + 1}`,
          author,
          draft: false,
          ci,
          mergeStatus: 'blocked',
          labels: [{ name: i % 2 ? 'bug' : 'docs', color: 'ededed' }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date(Date.now() - i * 1000).toISOString(),
        })),
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

async function open(
  page: Page,
  width: number,
  scheme: 'light' | 'dark' = 'light',
) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 800 });
  await seed(page);
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(SEEDS.length);
}

// The bar's own copy of a group: the Filters sheet holds a second one, hidden
// until a phone opens it.
const barGroup = (page: Page, name: string) =>
  page.locator('.filter-bar > .quick-pills').filter({
    has: page.getByText(name, { exact: true }),
  });

const phone = (width: number) => width <= 760;
const sheet = (page: Page) => page.locator('dialog#filter-sheet');
const filtersButton = (page: Page) =>
  page.getByRole('button', { name: /^Filters/ });

// The bar on a desktop, the open sheet on a phone: wherever the pills are.
async function openFilters(page: Page, width: number) {
  if (!phone(width)) return page.locator('.filter-bar');
  await filtersButton(page).click();
  await expect(sheet(page)).toBeVisible();
  return sheet(page);
}

for (const width of [1280, 390, 320]) {
  test(`at ${width}px every pill is drawn 32px high, outlined, with a count`, async ({
    page,
  }) => {
    await open(page, width);
    const scope = await openFilters(page, width);
    const pills = scope.locator('.filter-pill:visible');
    expect(await pills.count()).toBeGreaterThanOrEqual(7);
    const drawn = await pills.evaluateAll((ps) =>
      ps.map((p) => ({
        h: p.getBoundingClientRect().height,
        count: p.querySelector('.filter-pill-count')?.textContent ?? '',
        border: getComputedStyle(p).borderTopWidth,
        radius: getComputedStyle(p).borderTopLeftRadius,
      })),
    );
    for (const d of drawn) {
      expect(d.h).toBe(32);
      expect(d.count).toMatch(/^\d+$/);
      expect(d.border).toBe('1px');
    }
  });

  test(`at ${width}px the page does not scroll sideways`, async ({ page }) => {
    await open(page, width);
    await openFilters(page, width);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('the Forge and CI groups each have a visible label that names them', async ({
  page,
}) => {
  await open(page, 1280);
  for (const name of ['Forge', 'CI']) {
    const group = barGroup(page, name);
    await expect(group).toBeVisible();
    await expect(group.locator('.filter-group-label')).toHaveText(name);
  }
});

test('each pill counts the pull requests it would show', async ({ page }) => {
  await open(page, 1280);
  const count = async (group: string, name: string) =>
    (
      await barGroup(page, group)
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .innerText()
    )
      .replace(name, '')
      .trim();
  expect(await count('Forge', 'All')).toBe('5');
  expect(await count('Forge', 'GitHub')).toBe('3');
  expect(await count('Forge', 'Forgejo')).toBe('2');
  expect(await count('CI', 'All')).toBe('5');
  expect(await count('CI', 'Passing')).toBe('3');
  expect(await count('CI', 'Failing')).toBe('1');
  expect(await count('CI', 'Running')).toBe('1');

  // The groups combine, so choosing GitHub changes what the CI pills would
  // show, and leaves the Forge counts alone: choosing a forge replaces it.
  await barGroup(page, 'Forge')
    .getByRole('button', { name: /^GitHub/ })
    .click();
  expect(await count('CI', 'All')).toBe('3');
  expect(await count('CI', 'Passing')).toBe('2');
  expect(await count('CI', 'Failing')).toBe('1');
  expect(await count('Forge', 'GitHub')).toBe('3');
  expect(await count('Forge', 'Forgejo')).toBe('2');
});

test('the Forge counts follow an Author pick like every other group', async ({
  page,
}) => {
  await open(page, 1280);
  const count = async (group: string, name: string) =>
    (
      await barGroup(page, group)
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .innerText()
    )
      .replace(name, '')
      .trim();
  // Pick bo, who has one GitHub and one Forgejo pull request, both blocked.
  await page.locator('#shared-author-filter-button').first().click();
  // Authors are listed under their forge, so bo is ticked under each.
  for (const box of await page
    .getByRole('checkbox', { name: 'bo', exact: true })
    .all())
    await box.check();
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
  expect(await count('Forge', 'All')).toBe('2');
  expect(await count('Forge', 'GitHub')).toBe('1');
  expect(await count('Forge', 'Forgejo')).toBe('1');
  expect(await count('CI', 'All')).toBe('2');
});

test('a pressed pill is filled with the accent and an unpressed one is not', async ({
  page,
}) => {
  await open(page, 1280);
  const group = barGroup(page, 'CI');
  const all = group.getByRole('button', { name: /^All/ });
  const failing = group.getByRole('button', { name: /^Failing/ });
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  const fill = (p: typeof all) =>
    p.evaluate((el) => getComputedStyle(el).backgroundColor);
  const filledAll = await fill(all);
  const unfilled = await fill(failing);
  expect(filledAll).not.toBe(unfilled);
  await failing.click();
  await expect(failing).toHaveAttribute('aria-pressed', 'true');
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  expect(await fill(all)).toBe(unfilled);
});

for (const width of [390, 320]) {
  test.describe(`the Filters sheet at ${width}px`, () => {
    test('holds the same pills and three dropdowns with a visible label each', async ({
      page,
    }) => {
      await open(page, width);
      await openFilters(page, width);
      const body = sheet(page);
      for (const name of ['Forge', 'CI']) {
        const group = body.getByRole('group', { name, exact: true });
        await expect(group.locator('.filter-group-label')).toBeVisible();
        expect(
          await group.locator('.filter-pill[aria-pressed]').count(),
        ).toBeGreaterThan(1);
      }
      const labels = body.locator('.sheet-field-label:visible');
      await expect(labels).toHaveText(['Repository', 'Author', 'Label']);
      // Each label sits above its dropdown.
      for (const [label, host] of [
        ['Repository', '#shared-repo-filter'],
        ['Author', '#shared-author-filter'],
        ['Label', '#shared-label-filter'],
      ]) {
        const field = body.locator('.sheet-field', {
          has: page.locator(host),
        });
        const text = field.locator('.sheet-field-label');
        await expect(text).toHaveText(label);
        const button = field.locator('button.label-filter-button');
        const [t, b] = await Promise.all([
          text.boundingBox(),
          button.boundingBox(),
        ]);
        expect((t?.y ?? 0) + (t?.height ?? 0)).toBeLessThanOrEqual(b?.y ?? 0);
        await expect(button).toBeVisible();
      }
    });

    test('the footer button says how many results the filters leave', async ({
      page,
    }) => {
      await open(page, width);
      await openFilters(page, width);
      const show = page.locator('#filter-sheet-show');
      await expect(show).toHaveText('Show 5 results');
      await sheet(page)
        .getByRole('group', { name: 'Forge', exact: true })
        .getByRole('button', { name: /^GitHub/ })
        .click();
      await expect(show).toHaveText('Show 3 results');
      await sheet(page)
        .getByRole('group', { name: 'CI', exact: true })
        .getByRole('button', { name: /^Passing/ })
        .click();
      await expect(show).toHaveText('Show 2 results');
      await expect(page.locator('#pr-rows > .row:visible')).toHaveCount(2);
    });

    test('a pill is a 44px target around the 32px drawn pill, and targets never overlap', async ({
      page,
    }) => {
      await open(page, width);
      await openFilters(page, width);
      const pills = sheet(page).locator('.filter-pill:visible');
      const total = await pills.count();
      expect(total).toBeGreaterThanOrEqual(7);
      for (let i = 0; i < total; i++) {
        const pill = pills.nth(i);
        await pill.evaluate((p) => p.scrollIntoView({ block: 'center' }));
        expect((await pill.boundingBox())?.height).toBe(32);
        const hits = await pill.evaluate((p) => {
          const r = p.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const owns = (y: number) => {
            const e = document.elementFromPoint(x, y);
            return e === p || p.contains(e);
          };
          // The target runs 6px past the drawn edge.
          return [
            owns(r.top - 5),
            owns(r.bottom + 5),
            owns(r.top - 7.5),
            owns(r.bottom + 7.5),
          ];
        });
        expect(hits).toEqual([true, true, false, false]);
        const gap = await pill.evaluate((p) => {
          const r = p.getBoundingClientRect();
          const below = [
            ...document.querySelectorAll('#filter-sheet .filter-pill'),
          ]
            .filter((q) => (q as HTMLElement).offsetParent !== null)
            .find(
              (q) => q.getBoundingClientRect().top >= r.bottom - 1 && q !== p,
            );
          return below ? below.getBoundingClientRect().top - r.bottom : 99;
        });
        expect(gap).toBeGreaterThanOrEqual(12);
      }
    });
  });
}

test('on a desktop the hit area is the drawn pill', async ({ page }) => {
  await open(page, 1280);
  const pill = page.locator('.filter-bar .filter-pill:visible').first();
  const hit = await pill.evaluate((p) => {
    const r = p.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top - 5) === p;
  });
  expect(hit).toBe(false);
});

for (const width of [1280, 390, 320]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`the filters have no axe violations at ${width}px in ${scheme}`, async ({
      page,
    }) => {
      await open(page, width, scheme);
      await openFilters(page, width);
      const { violations } = await new AxeBuilder({ page })
        .include(phone(width) ? '#filter-sheet' : '.filter-bar')
        .analyze();
      expect(violations.map((v) => v.id)).toEqual([]);
    });
  }
}

test('the filter pill classes are the only pill look on the page', async ({
  page,
}) => {
  await open(page, 1280);
  // The legacy quick pill look is gone: nothing draws a 1px transparent pill.
  const looks = await page
    .locator('.filter-bar [data-pill]:visible')
    .evaluateAll((ps) => ps.map((p) => p.classList.contains('filter-pill')));
  expect(looks.length).toBeGreaterThan(0);
  expect(looks.every(Boolean)).toBe(true);
});
