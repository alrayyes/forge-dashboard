import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { pickOnly } from './label-filter-helper';
import { test } from './server-fixture';

// #1427: the Created and Updated ranges and the forge
// buttons offer only choices that exist in the results, like the repo, author
// and label selects do.
// https://github.com/alrayyes/forge-dashboard/issues/1427

const ago = (hours: number) =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: ago(48),
    updatedAt: ago(48),
    mergeStatus: 'mergeable',
    allowedActions: [{ action: 'merge' }, { action: 'close' }],
    ...overrides,
  };
}

async function open(
  page: Page,
  path: string,
  pullRequests: unknown[],
  forges: unknown[] = [forgeHealth('github')],
) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges,
        pullRequests,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(path);
}

const values = (page: Page, selector: string) =>
  page
    .locator(`${selector} option`)
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));

const CREATED = 'select[data-col="created"]';
const UPDATED = 'select[data-col="updated"]';

test.describe('age choices on the pull request page (#1427)', () => {
  test('offer only the age ranges something falls in', async ({ page }) => {
    await open(page, '/pull-requests.html', [
      pr(1, { ci: 'success', createdAt: ago(48), updatedAt: ago(2) }),
      pr(2, { ci: 'failure', createdAt: ago(72), updatedAt: ago(30) }),
    ]);
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

    // Created 48h and 72h ago: nothing is under an hour or a day old.
    expect(await values(page, CREATED)).toEqual(['', '10080', '43200']);
    // Updated 2h and 30h ago.
    expect(await values(page, UPDATED)).toEqual(['', '1440', '10080', '43200']);
  });

  test('a quick pill narrows the age ranges too', async ({ page }) => {
    await open(page, '/pull-requests.html', [
      pr(1, { ci: 'success', createdAt: ago(0.5) }),
      pr(2, { ci: 'failure', createdAt: ago(48) }),
    ]);
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    expect(await values(page, CREATED)).toContain('60');

    await page.getByRole('button', { name: 'Failing' }).click();

    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    expect(await values(page, CREATED)).toEqual(['', '10080', '43200']);
  });

  test('has no axe-core violations with the narrowed choices', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html', [
      pr(1, { ci: 'success' }),
      pr(2, { ci: 'failure', author: 'ann' }),
    ]);
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    await pickOnly(page, 'author', 'github:claude');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('forge buttons on Insights (#1427)', () => {
  const forgeGroup = (page: Page) =>
    page.getByRole('group', { name: 'Forge', exact: true });
  const forgePill = (page: Page, value: string) =>
    page.locator(`.filter-bar [data-forge-pill="${value}"]`);

  test('the buttons are the forges the API reports, named by its labels (#3976)', async ({
    page,
  }) => {
    const health = (forge: 'github' | 'forgejo', label: string) => ({
      ...forgeHealth(forge),
      capabilities: { ...forgeHealth(forge).capabilities, label },
    });
    const gitea = { ...forgeHealth('forgejo'), forge: 'gitea' };
    await open(
      page,
      '/insights.html',
      [
        pr(1),
        pr(2, { forge: 'forgejo', repo: 'ryan/infra' }),
        pr(3, {
          forge: 'gitea',
          repo: 'ryan/tools',
          allowedActions: [],
          status: null,
          kind: 'regular',
        }),
      ],
      [
        health('github', 'GitHub'),
        health('forgejo', 'Codeberg'),
        {
          ...gitea,
          capabilities: { ...gitea.capabilities, label: 'Gitea' },
        },
      ],
    );
    await expect(forgePill(page, 'gitea')).toBeVisible();
    await expect(forgeGroup(page).getByRole('button')).toHaveText([
      'All',
      'GitHub',
      'Codeberg',
      'Gitea',
    ]);
    await forgePill(page, 'gitea').click();
    await expect(forgePill(page, 'gitea')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('the Forge group is labelled, one pill is pressed, and a pill is a 44px target on a phone (#4615)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(
      page,
      '/insights.html',
      [pr(1), pr(2, { forge: 'forgejo', repo: 'ryan/infra' })],
      [forgeHealth('github'), forgeHealth('forgejo')],
    );
    const group = forgeGroup(page);
    await expect(group.locator('.filter-group-label')).toBeVisible();
    await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
    await expect(forgePill(page, '')).toHaveAttribute('aria-pressed', 'true');
    const pill = forgePill(page, 'forgejo');
    await expect(pill).toBeVisible();
    const owns = await pill.evaluate((p) => {
      const r = p.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const hit = (y: number) => {
        const e = document.elementFromPoint(x, y);
        return e === p || p.contains(e);
      };
      return [hit(r.top - 5), hit(r.bottom + 5)];
    });
    expect(owns).toEqual([true, true]);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a forge with nothing to chart is not offered', async ({ page }) => {
    // One forge is all there is, so the whole Forge filter is left out (#4273).
    await open(page, '/insights.html', [pr(1)]);
    await expect(page.locator('input[data-col="title"]')).toBeVisible();
    await expect(forgeGroup(page)).toBeHidden();
    await expect(forgePill(page, 'github')).toBeHidden();
    await expect(forgePill(page, 'forgejo')).toBeHidden();
  });

  test('picking a repo that leaves one forge hides the forge buttons', async ({
    page,
  }) => {
    await open(page, '/insights.html', [
      pr(1),
      pr(2, { forge: 'forgejo', repo: 'ryan/infra' }),
    ]);
    await expect(forgePill(page, 'forgejo')).toBeVisible();

    await pickOnly(page, 'repo', 'github:alrayyes/app');

    // One forge is left, so the Forge filter goes whole (#4273).
    await expect(forgeGroup(page)).toBeHidden();
    await expect(forgePill(page, 'github')).toBeHidden();
    await expect(forgePill(page, 'forgejo')).toBeHidden();
  });

  test('a forge you picked stays offered after a reload that finds nothing on it', async ({
    page,
  }) => {
    await open(page, '/insights.html', [
      pr(1),
      pr(2, { forge: 'forgejo', repo: 'ryan/infra' }),
    ]);
    // The saved pick has to reach the server before the page reloads.
    const saved = page.waitForResponse(
      (r) =>
        r.url().includes('/api/v1/settings/filter-state') &&
        r.request().method() !== 'GET',
    );
    await forgePill(page, 'forgejo').click();
    await expect(forgePill(page, 'forgejo')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await saved;
    await page.unroute('**/api/v1/dashboard*');
    await page.route('**/api/v1/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [forgeHealth('github')],
          pullRequests: [pr(1)],
          issues: [],
          openIssueCount: 0,
          repos: [],
          hiddenDrafts: 0,
        }),
      }),
    );
    await page.reload();

    await expect(forgePill(page, 'github')).toBeVisible();
    await expect(forgePill(page, 'forgejo')).toBeVisible();
    await expect(forgePill(page, 'forgejo')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('both are offered when both forges have pull requests', async ({
    page,
  }) => {
    await open(page, '/insights.html', [
      pr(1),
      pr(2, { forge: 'forgejo', repo: 'ryan/infra' }),
    ]);
    await expect(forgePill(page, 'github')).toBeVisible();
    await expect(forgePill(page, 'forgejo')).toBeVisible();
  });
});
