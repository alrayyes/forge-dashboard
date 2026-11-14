import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// The Issues page shows the pull requests that only reference an issue as
// refs pills beside the closing ones. Both pages filter on one refs relation
// that covers a close as well as a plain ref; there is no separate closing
// filter. Mocks /api/v1/dashboard and the details endpoint only.
// https://github.com/alrayyes/forge-dashboard/issues/3612
// https://github.com/alrayyes/forge-dashboard/issues/3655
// https://github.com/alrayyes/forge-dashboard/issues/3657

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

async function open(
  page: Page,
  path: string,
  issues: unknown[] = ISSUES,
  prs: unknown[] = PRS,
) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: prs,
        issues,
        openIssueCount: issues.length,
        repos: [],
        hiddenDrafts: 0,
        navCounts: navCountsFor(prs as never, issues.length),
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
    ).toHaveAccessibleName(
      /^Pull request #2.*, references, does not close this issue$/,
    );
    await expect(closePills(page, 'Fixed and referenced')).toHaveAccessibleName(
      /^Pull request #1.*, closes this issue$/,
    );
    await expect(refPills(page, 'Nobody on it')).toHaveCount(0);
    await expect(refPills(page, 'Has a fix coming')).toHaveCount(0);
    const border = (locator: ReturnType<typeof refPills>) =>
      locator.first().evaluate((el) => getComputedStyle(el).borderTopStyle);
    // Retries until both pills are styled; an unstyled pill reads as ''.
    await expect
      .poll(async () => {
        const a = await border(refPills(page, 'Only mentioned by work'));
        const b = await border(closePills(page, 'Has a fix coming'));
        return a !== '' && b !== '' && a !== b;
      })
      .toBe(true);
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

    // Retries until both pills are styled.
    await expect
      .poll(async () => {
        const a = await outline(refPills(page, 'Draft fix and a reference'));
        const b = await outline(draft);
        return !a.startsWith(' ') && !b.startsWith(' ') && a !== b;
      })
      .toBe(true);
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

  test('a refs pill says in its tooltip that it does not close the issue', async ({
    page,
  }) => {
    await open(page, '/issues.html');
    const pill = refPills(page, 'Fixed and referenced').first();
    await expect(pill).toHaveAttribute(
      'title',
      'References this issue, does not close it',
    );
    await expect(
      rowOf(page, 'Fixed and referenced')
        .locator('.linked-pr:not(.refs-pill)')
        .first(),
    ).toHaveAttribute('title', 'Closes this issue when it merges');
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
    // Reachable without hover, so a phone reader gets it too.
    await expect(popup.locator('.mentioned-by-hint')).toHaveText(
      'Italic: these reference the issue, they do not close it.',
    );
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

      // Retries until the pseudo-element has a laid-out size of 44px or more.
      await expect
        .poll(
          () =>
            pill.evaluate((el) => {
              const after = getComputedStyle(el, '::after');
              return Math.min(
                Number.parseFloat(after.width) || 0,
                Number.parseFloat(after.height) || 0,
              );
            }),
          { message: scheme },
        )
        .toBeGreaterThanOrEqual(44);
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
    await expect(prTitles(page)).toHaveCount(3);
    await expect(page.locator('#pr-rows')).toContainText('Fixes a bug');
    await expect(page.locator('#pr-rows')).toContainText('Part of a larger');
    await expect(page.locator('#pr-rows')).not.toContainText(
      'Standalone change',
    );
    await expect(choice(page, 'yes')).toHaveAttribute('aria-pressed', 'true');

    await choice(page, 'no').click();
    await expect(prTitles(page)).toHaveCount(1);
    await expect(page.locator('#pr-rows')).toContainText('Standalone change');

    await choice(page, 'any').click();
    await expect(prTitles(page)).toHaveCount(4);
  });

  test('offers no separate closing filter, and ignores an old saved closing choice', async ({
    page,
  }) => {
    await page.route(
      '**/api/v1/settings/filter-state',
      async (route: Route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            shared: {},
            pr: { closes: 'yes' },
            issue: { closedBy: 'no' },
            view: {},
          }),
        });
      },
    );
    await open(page, '/pull-requests.html');

    await expect(page.locator('.link-group')).toHaveCount(0);
    await expect(page.getByText('Closing issue')).toHaveCount(0);
    await expect(prTitles(page)).toHaveCount(4);
    await expect(
      page.getByRole('button', { name: /^Remove filter/ }),
    ).toHaveCount(0);
    await expect(page.locator('#held-picks')).toBeEmpty();
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
    await expect(prTitles(page)).toHaveCount(3);

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
    await expect(prTitles(page)).toHaveCount(1);
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
    await expect(issueTitles(page)).toHaveCount(4);

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
    await expect(issueTitles(page)).toHaveCount(4);
    await expect(page.locator('#issue-rows')).toContainText('Has a fix coming');
    await expect(page.locator('#issue-rows')).toContainText(
      'Only mentioned by work',
    );
    await expect(page.locator('#issue-rows')).not.toContainText('Nobody on it');

    await choice(page, 'no').click();
    await expect(issueTitles(page)).toHaveCount(1);
    await expect(page.locator('#issue-rows')).toContainText('Nobody on it');
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

  test('a control with one real choice is hidden, and shown once both are backed', async ({
    page,
  }) => {
    await open(page, '/issues.html', [issue(24, 'Nobody on it')]);
    await expect(page.locator('.filter-bar > .refs-group')).toBeHidden();

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await open(page, '/issues.html', [
      issue(22, 'Referenced', [], [prLink(2)]),
    ]);
    await expect(page.locator('.filter-bar > .refs-group')).toBeHidden();

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await open(page, '/issues.html', [
      issue(22, 'Referenced', [], [prLink(2)]),
      issue(24, 'Nobody on it'),
    ]);
    await expect(choice(page, 'yes')).toBeVisible();
    await expect(choice(page, 'no')).toBeVisible();
  });
});

// One test loops both pages, both themes and both widths: the filter bar is
// the same code in each, so eight tests only paid for eight page loads.
test('the pull request and issue filter bars have no axe violations in light and dark at 390 and 1280px with the pick on', async ({
  page,
}) => {
  for (const width of [390, 1280]) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const path of ['/pull-requests.html', '/issues.html']) {
        const where = `${path} at ${width}px in ${scheme}`;
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        await open(page, path);
        if (width === 390) {
          await page.getByRole('button', { name: /^Filters/ }).click();
          const sheet = page.locator('dialog#filter-sheet .refs-group');
          await sheet.locator('[data-ref="yes"]').click();
          for (const value of ['any', 'yes', 'no']) {
            const box = await sheet
              .locator(`[data-ref="${value}"]`)
              .boundingBox();
            expect(box?.height, where).toBeGreaterThanOrEqual(44);
          }
        } else {
          await choice(page, 'yes').click();
          await expect(choice(page, 'yes'), where).toHaveAttribute(
            'aria-pressed',
            'true',
          );
        }
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations, where).toEqual([]);
      }
    }
  }
});

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const isSave = (r: { url(): string; request(): { method(): string } }) =>
  r.url().includes('/api/v1/settings/filter-state') &&
  r.request().method() !== 'GET';

test.describe('a saved closing choice from before the merge', () => {
  test('is not sent back when the state is saved again, with no axe violations', async ({
    page,
  }) => {
    await page.route(
      '**/api/v1/settings/filter-state',
      async (route: Route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            shared: {},
            pr: { closes: 'yes' },
            issue: { closedBy: 'no' },
            view: {},
          }),
        });
      },
    );
    await open(page, '/pull-requests.html');
    await expect(prTitles(page)).toHaveCount(4);

    const put = page.waitForRequest(
      (r) =>
        r.url().includes('/api/v1/settings/filter-state') &&
        r.method() === 'PUT',
    );
    await choice(page, 'yes').click();
    const body = (await put).postDataJSON() as {
      pr: Record<string, unknown>;
      issue: Record<string, unknown>;
    };

    expect(body.pr.refs).toBe('yes');
    expect(body.pr).not.toHaveProperty('closes');
    expect(body.issue).not.toHaveProperty('closedBy');
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
});

// Two bot pull requests and two release ones, one of each referencing. Each
// referencing one only references an issue: a plain link, no closing keyword.
const mixed = [
  ...PRS,
  {
    ...pr(5, 'Bump a library', [], [issueLink(22, 'refs')]),
    author: 'dependabot[bot]',
    kind: 'dependency',
  },
  { ...pr(6, 'Bump another library'), kind: 'dependency' },
  {
    ...pr(7, 'Release 2.0.0', [], [issueLink(21, 'refs')]),
    kind: 'release',
  },
  { ...pr(8, 'Release 2.1.0'), kind: 'release' },
];

test.describe('the references pick made on Pull requests', () => {
  async function pickOnPullRequests(page: Page) {
    await open(page, '/pull-requests.html', ISSUES, mixed);
    const saved = page.waitForResponse(isSave);
    await choice(page, 'yes').click();
    await saved;
  }

  test('shows on the Bots page and Any clears it there', async ({ page }) => {
    await pickOnPullRequests(page);
    await page.goto('/bots.html');
    await expect(prTitles(page).first()).toBeVisible();

    await expect(choice(page, 'yes')).toHaveAttribute('aria-pressed', 'true');
    await expect(prTitles(page)).toHaveText(['#5 Bump a library']);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);

    const cleared = page.waitForResponse(isSave);
    await choice(page, 'any').click();
    await cleared;
    await expect(prTitles(page)).toHaveCount(2);

    await page.goto('/pull-requests.html');
    await expect(choice(page, 'any')).toHaveAttribute('aria-pressed', 'true');
  });

  test('shows on the Releases page and Clear filters clears it there', async ({
    page,
  }) => {
    await pickOnPullRequests(page);
    await page.goto('/releases.html');
    await expect(prTitles(page).first()).toBeVisible();

    await expect(choice(page, 'yes')).toHaveAttribute('aria-pressed', 'true');
    await expect(prTitles(page)).toHaveText(['#7 Release 2.0.0']);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);

    const cleared = page.waitForResponse(isSave);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await cleared;
    await expect(prTitles(page)).toHaveCount(2);

    await page.goto('/pull-requests.html');
    await expect(choice(page, 'any')).toHaveAttribute('aria-pressed', 'true');
  });
});
