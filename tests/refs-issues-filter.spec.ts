import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// The Issues page shows the pull requests that only reference an issue as
// refs pills beside the closing ones, and both pages filter on the refs
// relation the way they filter on closing. Mocks /api/v1/dashboard and the
// details endpoint only.
// https://github.com/alrayyes/forge-dashboard/issues/3612

const REPO = 'acme/app';
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const issueLink = (number: number, relation: 'closes' | 'refs') => ({
  repo: REPO,
  number,
  relation,
  tracked: true,
  url: `https://example.com/i/${number}`,
  pageUrl: `/issues.html?issue=github/${REPO}/${number}`,
});

const prLink = (number: number, draft = false) => ({
  forge: 'github',
  repo: REPO,
  number,
  draft,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  ci: 'success',
  checks: { passed: 1, running: 0, waiting: 0, failed: 0 },
  awaitingWorkflowApproval: false,
});

function pr(
  number: number,
  title: string,
  closesIssues: unknown[] = [],
  refsIssues: unknown[] = [],
) {
  return {
    forge: 'github',
    repo: REPO,
    number,
    title,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: ago(60),
    updatedAt: ago(100 - number),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    closesIssues,
    refsIssues,
    mentionsIssues: [],
  };
}

function issue(
  number: number,
  title: string,
  linked: unknown[] = [],
  referenced: unknown[] = [],
) {
  return {
    forge: 'github',
    repo: REPO,
    number,
    title,
    url: `https://example.com/issues/${number}`,
    author: 'alrayyes',
    labels: [],
    createdAt: ago(number),
    updatedAt: ago(number),
    linkedPullRequests: linked,
    referencedByPullRequests: referenced,
    mentionedByPullRequests: [],
  };
}

// Issue 21 has a closing pull request, 22 a referencing one, 23 both, 24 none.
const ISSUES = [
  issue(21, 'Has a fix coming', [prLink(1)]),
  issue(22, 'Only mentioned by work', [], [prLink(2)]),
  issue(23, 'Fixed and referenced', [prLink(1)], [prLink(2), prLink(3)]),
  issue(24, 'Nobody on it'),
  issue(25, 'Draft fix and a reference', [prLink(5, true)], [prLink(2)]),
];
// Pull request 1 closes, 2 references, 3 references and closes, 4 neither.
const PRS = [
  pr(1, 'Fixes a bug', [issueLink(21, 'closes')]),
  pr(2, 'Part of a larger change', [], [issueLink(22, 'refs')]),
  pr(
    3,
    'Fixes one and touches another',
    [issueLink(23, 'closes')],
    [issueLink(22, 'refs')],
  ),
  pr(4, 'Standalone change'),
];

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const details = {
  description: {
    text: 'The **pull request** text.',
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
};

async function open(page: Page, path: string, issues: unknown[] = ISSUES) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: PRS,
        issues,
        openIssueCount: issues.length,
        repos: [],
        hiddenDrafts: 0,
        navCounts: navCountsFor(PRS as never, issues.length),
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(details),
    }),
  );
  await page.goto(path);
  // The segments are in the markup before the script wires them.
  await expect(page.locator('.row').first()).toBeVisible();
}

const rowOf = (page: Page, title: string) =>
  page.locator('#issue-rows .row', { hasText: title });
const refPills = (page: Page, title: string) =>
  rowOf(page, title).locator('.refs-pill');
const closePills = (page: Page, title: string) =>
  rowOf(page, title).locator('.linked-pr:not(.refs-pill)');

const bar = (page: Page) => page.locator('.filter-bar > .refs-group');
const choice = (page: Page, value: 'any' | 'yes' | 'no') =>
  bar(page).locator(`[data-ref="${value}"]`);
const closingChoice = (page: Page, value: 'any' | 'yes' | 'no') =>
  page.locator(`.filter-bar > .link-group [data-link="${value}"]`);
const prTitles = (page: Page) => page.locator('#pr-rows > .row .title-text');
const issueTitles = (page: Page) =>
  page.locator('#issue-rows > .row .title-text');

test.describe('the refs pill on an issue row', () => {
  test('sits beside the closing pill, is named for a screen reader and is drawn apart', async ({
    page,
  }) => {
    await open(page, '/issues.html');

    await expect(closePills(page, 'Fixed and referenced')).toHaveText(/^#1/);
    await expect(refPills(page, 'Fixed and referenced')).toHaveText([
      /^#2/,
      /^#3/,
    ]);
    await expect(
      refPills(page, 'Fixed and referenced').first(),
    ).toHaveAccessibleName(/^Pull request #2.*, references this issue$/);
    await expect(closePills(page, 'Fixed and referenced')).toHaveAccessibleName(
      /^Pull request #1.*, closes this issue$/,
    );
    await expect(refPills(page, 'Nobody on it')).toHaveCount(0);
    await expect(refPills(page, 'Has a fix coming')).toHaveCount(0);
    const border = (locator: ReturnType<typeof refPills>) =>
      locator.first().evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect(await border(refPills(page, 'Only mentioned by work'))).not.toBe(
      await border(closePills(page, 'Has a fix coming')),
    );
  });

  test('is not drawn like a draft pill', async ({ page }) => {
    await open(page, '/issues.html');
    const outline = (locator: ReturnType<typeof refPills>) =>
      locator.first().evaluate((el) => {
        const style = getComputedStyle(el);
        return `${style.borderTopStyle} ${style.fontStyle}`;
      });

    const draft = page
      .locator('#issue-rows .row', { hasText: 'Draft fix and a reference' })
      .locator('.linked-pr.draft');
    await expect(draft).toHaveCount(1);

    expect(await outline(refPills(page, 'Draft fix and a reference'))).not.toBe(
      await outline(draft),
    );
  });

  test('keeps the pills behind a count, worded for references', async ({
    page,
  }) => {
    await open(page, '/issues.html', [
      issue(
        30,
        'Many references',
        [],
        [prLink(2), prLink(3), prLink(4), prLink(5)],
      ),
    ]);
    const more = rowOf(page, 'Many references').getByRole('button', {
      name: /^2 more/,
    });

    await expect(refPills(page, 'Many references')).toHaveCount(2);
    await expect(more).toHaveAccessibleName(
      '2 more pull requests that reference this issue',
    );
    await more.click();
    await expect(refPills(page, 'Many references')).toHaveCount(4);
  });

  test('is in the issue pop-up under Referenced in, with no axe violations', async ({
    page,
  }) => {
    await open(page, '/issues.html');
    await rowOf(page, 'Fixed and referenced')
      .getByRole('button', { name: /Fixed and referenced/ })
      .first()
      .click();

    const popup = page.getByRole('dialog', { name: /^Issue details/ });
    await expect(popup).toBeVisible();
    await expect(popup.locator('.mentioned-by-label')).toHaveText(
      'Referenced in',
    );
    await expect(popup.locator('.refs-pill')).toHaveCount(2);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('opens the pull request dialog in place and returns focus on Escape', async ({
    page,
  }) => {
    await open(page, '/issues.html');
    const pill = refPills(page, 'Only mentioned by work');

    await pill.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: /^Pull request details/ });
    await expect(dialog).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/issues.html');

    await page.keyboard.press('Escape');

    await expect(dialog).toBeHidden();
    await expect(pill).toBeFocused();
  });

  test('has a 44 px hit area on a phone, no sideways scroll and no axe violations in both themes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, '/issues.html');
      const pill = refPills(page, 'Fixed and referenced').first();
      await expect(pill).toBeVisible();

      const area = await pill.evaluate((el) => {
        const after = getComputedStyle(el, '::after');
        return {
          width: Number.parseFloat(after.width),
          height: Number.parseFloat(after.height),
        };
      });
      expect(area.height, scheme).toBeGreaterThanOrEqual(44);
      expect(area.width, scheme).toBeGreaterThanOrEqual(44);
      const scrolls = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      expect(scrolls, `${scheme} scrolls sideways`).toBe(false);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations, scheme).toEqual([]);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });
});

test.describe('Pull requests: references an issue', () => {
  test('References an issue and References no issue split the list', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html');
    await expect(prTitles(page)).toHaveCount(4);

    await choice(page, 'yes').click();
    await expect(prTitles(page)).toHaveCount(2);
    await expect(page.locator('#pr-rows')).not.toContainText('Fixes a bug');
    await expect(choice(page, 'yes')).toHaveAttribute('aria-pressed', 'true');

    await choice(page, 'no').click();
    await expect(prTitles(page)).toHaveCount(2);
    await expect(page.locator('#pr-rows')).toContainText('Standalone change');
    await expect(page.locator('#pr-rows')).toContainText('Fixes a bug');

    await choice(page, 'any').click();
    await expect(prTitles(page)).toHaveCount(4);
  });

  test('combines with the closing pick', async ({ page }) => {
    await open(page, '/pull-requests.html');

    await choice(page, 'yes').click();
    await closingChoice(page, 'yes').click();

    await expect(prTitles(page)).toHaveCount(1);
    await expect(prTitles(page).first()).toContainText('touches another');
    await choice(page, 'any').click();
    await expect(prTitles(page)).toHaveCount(2);
  });

  test('the pick survives a reload and Clear filters resets it', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html');
    const saved = page.waitForResponse(
      (r) =>
        r.url().includes('/api/v1/settings/filter-state') &&
        r.request().method() !== 'GET',
    );
    await choice(page, 'yes').click();
    await saved;
    await page.reload();
    await expect(choice(page, 'yes')).toHaveAttribute('aria-pressed', 'true');
    await expect(prTitles(page)).toHaveCount(2);

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(choice(page, 'any')).toHaveAttribute('aria-pressed', 'true');
    await expect(prTitles(page)).toHaveCount(4);
  });

  test('on a 390px phone it is in the Filters sheet with 44px choices and no axe violations', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page, '/pull-requests.html');
    await expect(bar(page)).toBeHidden();

    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.locator('dialog#filter-sheet .refs-group');
    for (const value of ['any', 'yes', 'no']) {
      const box = await sheet.locator(`[data-ref="${value}"]`).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    await sheet.locator('[data-ref="no"]').click();
    await page.keyboard.press('Escape');
    await expect(prTitles(page)).toHaveCount(2);
    await expect(
      page.getByRole('button', { name: 'Remove filter: References no issue' }),
    ).toBeVisible();
  });

  test('on a phone the Issues page chip names the pick and removes it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page, '/issues.html');
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page
      .locator('dialog#filter-sheet .refs-group [data-ref="yes"]')
      .click();
    await page.keyboard.press('Escape');
    await expect(issueTitles(page)).toHaveCount(3);

    await page
      .getByRole('button', {
        name: 'Remove filter: Has a referencing pull request',
      })
      .click();
    await expect(issueTitles(page)).toHaveCount(5);
  });
});

test.describe('Issues: has a referencing pull request', () => {
  test('the two choices split the list', async ({ page }) => {
    await open(page, '/issues.html');
    await expect(issueTitles(page)).toHaveCount(5);

    await choice(page, 'yes').click();
    await expect(issueTitles(page)).toHaveCount(3);
    await expect(page.locator('#issue-rows')).not.toContainText('Nobody on it');

    await choice(page, 'no').click();
    await expect(issueTitles(page)).toHaveCount(2);
    await expect(page.locator('#issue-rows')).toContainText('Has a fix coming');
  });

  test('combines with the closing pick', async ({ page }) => {
    await open(page, '/issues.html');

    await choice(page, 'yes').click();
    await closingChoice(page, 'yes').click();

    await expect(issueTitles(page)).toHaveCount(2);
    await expect(page.locator('#issue-rows')).not.toContainText(
      'Only mentioned by work',
    );
  });

  test('stays offered when nothing matches, and the two pages keep their own pick', async ({
    page,
  }) => {
    await open(page, '/issues.html');
    const saved = page.waitForResponse(
      (r) =>
        r.url().includes('/api/v1/settings/filter-state') &&
        r.request().method() !== 'GET',
    );
    await choice(page, 'yes').click();
    await saved;

    await page.goto('/pull-requests.html');
    await expect(choice(page, 'any')).toHaveAttribute('aria-pressed', 'true');
    await expect(prTitles(page)).toHaveCount(4);
  });

  test('a choice nothing matches is not offered, and the segment goes when neither is', async ({
    page,
  }) => {
    await open(page, '/issues.html', [issue(24, 'Nobody on it')]);
    await expect(choice(page, 'no')).toBeVisible();
    await expect(choice(page, 'yes')).toBeHidden();

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await open(page, '/issues.html', [
      issue(22, 'Referenced', [], [prLink(2)]),
    ]);
    await expect(choice(page, 'yes')).toBeVisible();
    await expect(choice(page, 'no')).toBeHidden();
  });
});
