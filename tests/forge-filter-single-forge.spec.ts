import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { pickedValues, pickOnly, togglePicks } from './label-filter-helper';
import { groupBar, quickPill } from './quick-pills-helper';
import { test } from './server-fixture';

// #4273: the Forge filter is offered only while the repos in scope span more
// than one forge. A forge already picked when the filter goes away is cleared,
// never left active and out of sight.
// https://github.com/alrayyes/forge-dashboard/issues/4273

function pr(number: number, forge: string, repo: string) {
  return {
    forge,
    repo,
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
  };
}

const pullRequests = [
  pr(1, 'github', 'alrayyes/app'),
  pr(2, 'github', 'alrayyes/lib'),
  pr(3, 'forgejo', 'infra/wiki'),
];

async function open(
  page: Page,
  path: string,
  {
    rows = pullRequests,
    gate,
  }: { rows?: unknown[]; gate?: Promise<void> } = {},
) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', async (route: Route) => {
    await gate;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github'), forgeHealth('forgejo')],
        pullRequests: rows,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    });
  });
  await page.goto(path);
}

const forgeGroup = (page: Page) => groupBar(page, 'forge');
const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

test.describe('the Forge filter follows the repos in scope (#4273)', () => {
  test('hides when the repo filter leaves one forge, and comes back when widened', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    await expect(forgeGroup(page)).toBeVisible();
    expect((await axe(page)).violations).toEqual([]);

    await pickOnly(page, 'repo', 'github:alrayyes/app');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    await expect(forgeGroup(page)).toBeHidden();
    await expect(quickPill(page, 'GitHub')).toBeHidden();
    await expect(quickPill(page, 'Forgejo')).toBeHidden();
    expect((await axe(page)).violations).toEqual([]);

    // A second repo on the same forge still leaves one forge.
    await togglePicks(page, 'repo', 'github:alrayyes/lib');
    await expect(forgeGroup(page)).toBeHidden();

    // A repo on the other forge brings it back.
    await togglePicks(page, 'repo', 'forgejo:infra/wiki');
    await expect(forgeGroup(page)).toBeVisible();
    await expect(quickPill(page, 'Forgejo')).toBeVisible();
  });

  test('clears a forge pick that the narrowed repo filter makes redundant', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    await quickPill(page, 'GitHub').click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

    await pickOnly(page, 'repo', 'github:alrayyes/app');

    await expect(forgeGroup(page)).toBeHidden();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    // Nothing is left active out of sight: widening shows All, not GitHub.
    await pickOnly(page, 'repo', '');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    await expect(quickPill(page, 'All', 'forge')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('the Insights page hides the Forge filter by the same rule', async ({
    page,
  }) => {
    await open(page, '/insights.html');
    const forge = page.getByRole('group', { name: 'Filter by forge' });
    await expect(forge).toBeVisible();
    expect((await axe(page)).violations).toEqual([]);

    await pickOnly(page, 'repo', 'github:alrayyes/app');
    await expect(forge).toBeHidden();
    expect((await axe(page)).violations).toEqual([]);

    await pickOnly(page, 'repo', '');
    await expect(forge).toBeVisible();
    expect(await pickedValues(page, 'repo')).toEqual([]);
  });

  test('the Forge group is not drawn before the first snapshot, then appears only for two forges', async ({
    page,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await open(page, '/pull-requests.html', { gate });
    // The snapshot is still on its way: the group is in the page but not shown.
    await expect(forgeGroup(page)).toBeHidden();
    await expect(forgeGroup(page)).toHaveAttribute('hidden', '');
    release();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    await expect(forgeGroup(page)).toBeVisible();
  });

  test('a single forge never draws the Forge group, before or after the snapshot', async ({
    page,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await open(page, '/pull-requests.html', {
      gate,
      rows: [pr(1, 'github', 'alrayyes/app'), pr(2, 'github', 'alrayyes/lib')],
    });
    await expect(forgeGroup(page)).toBeHidden();
    release();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    await expect(forgeGroup(page)).toBeHidden();
  });

  test('Insights draws no Forge group before the snapshot, then follows the forges', async ({
    page,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await open(page, '/insights.html', { gate });
    const forge = page.getByRole('group', { name: 'Filter by forge' });
    await expect(forge).toBeHidden();
    await expect(page.locator('.forge-segmented')).toHaveAttribute(
      'hidden',
      '',
    );
    release();
    await expect(forge).toBeVisible();
    expect((await axe(page)).violations).toEqual([]);
  });

  test('Insights never draws the Forge group for a single forge', async ({
    page,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await open(page, '/insights.html', {
      gate,
      rows: [pr(1, 'github', 'alrayyes/app'), pr(2, 'github', 'alrayyes/lib')],
    });
    const forge = page.getByRole('group', { name: 'Filter by forge' });
    await expect(forge).toBeHidden();
    release();
    await expect(page.locator('input[data-col="title"]')).toBeVisible();
    await expect(forge).toBeHidden();
  });
});
