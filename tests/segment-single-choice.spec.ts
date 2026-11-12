import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A filter control offers a choice only while it would change the list (#3669):
// a choice that backs the whole pool shows what Any shows, and one that backs
// nothing shows nothing. A segment or pill group with nothing left is hidden,
// in the bar and in the phone Filters sheet, unless the pick is active.
// The segment rule is unit-tested in filters.test.ts; this is the wiring on
// every overview page that has the control.
// https://github.com/alrayyes/forge-dashboard/issues/3669

type Kind = 'regular' | 'dependency' | 'release';
const PAGES = [
  { name: 'Pull requests', path: '/pull-requests.html', kind: 'regular' },
  { name: 'Bots', path: '/bots.html', kind: 'dependency' },
  { name: 'Releases', path: '/releases.html', kind: 'release' },
] as const;

function pr(
  number: number,
  kind: Kind,
  overrides: Record<string, unknown> = {},
) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Change ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'sam',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind,
    closesIssues: [],
    refsIssues: [],
    mentionsIssues: [],
    ...overrides,
  };
}

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: 'sam',
    labels: [],
    createdAt: new Date(Date.now() - number * 1000).toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    linkedPullRequests: [],
    referencedByPullRequests: [],
    mentionedByPullRequests: [],
    ...overrides,
  };
}

const refLink = {
  repo: 'acme/app',
  number: 9,
  relation: 'refs',
  tracked: true,
};
const prLink = {
  forge: 'github',
  repo: 'acme/app',
  number: 9,
  draft: false,
  pageUrl: '/pull-requests.html?pr=github/acme/app/9',
  ci: 'success',
  checks: { passed: 1, running: 0, waiting: 0, failed: 0 },
  awaitingWorkflowApproval: false,
};

async function open(
  page: Page,
  path: string,
  data: { prs?: unknown[]; issues?: unknown[] },
  saved: Record<string, unknown> = {},
) {
  const prs = data.prs ?? [];
  const issues = data.issues ?? [];
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
      }),
    }),
  );
  if (Object.keys(saved).length > 0)
    await page.route('**/api/v1/settings/filter-state', (route: Route) =>
      route.request().method() !== 'GET'
        ? route.fallback()
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              shared: {},
              pr: {},
              issue: {},
              view: {},
              ...saved,
            }),
          }),
    );
  await page.goto(path);
  await expect(page.locator('.row').first()).toBeVisible();
}

const openSheet = async (page: Page) => {
  await page.getByRole('button', { name: /^Filters/ }).click();
  return page.locator('dialog#filter-sheet');
};
const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

for (const { name, path, kind } of PAGES) {
  test.describe(`${name}: a control with one real choice`, () => {
    test('Refs issue is hidden in the bar when no pull request references an issue', async ({
      page,
    }) => {
      await open(page, path, { prs: [pr(1, kind), pr(2, kind)] });
      await expect(page.locator('.filter-bar > .refs-group')).toBeHidden();
      expect((await axe(page)).violations).toEqual([]);
    });

    test('Refs issue is hidden in the phone Filters sheet, with no axe violations', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await open(page, path, { prs: [pr(1, kind), pr(2, kind)] });
      const sheet = await openSheet(page);
      await expect(sheet.locator('.refs-group')).toBeHidden();
      expect((await axe(page)).violations).toEqual([]);
    });

    test('Refs issue shows Any and both choices when both are backed', async ({
      page,
    }) => {
      await open(page, path, {
        prs: [pr(1, kind, { refsIssues: [refLink] }), pr(2, kind)],
      });
      const group = page.locator('.filter-bar > .refs-group');
      await expect(group.locator('[data-ref="any"]')).toBeVisible();
      await expect(group.locator('[data-ref="yes"]')).toBeVisible();
      await expect(group.locator('[data-ref="no"]')).toBeVisible();
      expect((await axe(page)).violations).toEqual([]);
    });

    test('Refs issue stays when its lone backed choice is the active pick', async ({
      page,
    }) => {
      await open(
        page,
        path,
        { prs: [pr(1, kind), pr(2, kind)] },
        { pr: { refs: 'no' } },
      );
      const group = page.locator('.filter-bar > .refs-group');
      await expect(group).toBeVisible();
      await expect(group.locator('[data-ref="no"]')).toBeVisible();
      await expect(group.locator('[data-ref="no"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(group.locator('[data-ref="any"]')).toBeVisible();
    });

    for (const [label, flag] of [
      ['only On', true],
      ['only Off', false],
    ] as const) {
      test(`Auto-merge is hidden in the bar and the sheet when ${label} is backed`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 390, height: 800 });
        await open(page, path, {
          prs: [
            pr(1, kind, { autoMergeEnabled: flag }),
            pr(2, kind, { autoMergeEnabled: flag }),
          ],
        });
        await expect(page.locator('.filter-bar > .am-group')).toBeHidden();
        const sheet = await openSheet(page);
        await expect(sheet.locator('.am-group')).toBeHidden();
        expect((await axe(page)).violations).toEqual([]);
      });
    }

    test('Auto-merge shows On and Off when both are backed, and stays for a lone active pick', async ({
      page,
    }) => {
      await open(page, path, {
        prs: [
          pr(1, kind, { autoMergeEnabled: true }),
          pr(2, kind, { autoMergeEnabled: false }),
        ],
      });
      const group = page.locator('.filter-bar > .am-group');
      await expect(group.locator('[data-am="on"]')).toBeVisible();
      await expect(group.locator('[data-am="off"]')).toBeVisible();

      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await open(
        page,
        path,
        {
          prs: [
            pr(1, kind, { autoMergeEnabled: true }),
            pr(2, kind, { autoMergeEnabled: true }),
          ],
        },
        { pr: { autoMerge: 'on' } },
      );
      await expect(group).toBeVisible();
      await expect(group.locator('[data-am="on"]')).toBeVisible();
      await expect(group.locator('[data-am="on"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    test('the GitHub and Forgejo pills are hidden when every row is on one forge, in the bar and the sheet', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await open(page, path, { prs: [pr(1, kind), pr(2, kind)] });
      const sheet = await openSheet(page);
      await expect(sheet.locator('[data-pill="github"]')).toBeHidden();
      await expect(sheet.locator('[data-pill="forgejo"]')).toBeHidden();
      await expect(
        page.locator('.quick-pills [data-pill="github"]'),
      ).toBeHidden();
      expect((await axe(page)).violations).toEqual([]);
    });

    test('the forge pills show when the rows span both forges', async ({
      page,
    }) => {
      await open(page, path, {
        prs: [pr(1, kind), pr(2, kind, { forge: 'forgejo' })],
      });
      const bar = page.locator('.quick-pills');
      await expect(bar.locator('[data-pill="github"]')).toBeVisible();
      await expect(bar.locator('[data-pill="forgejo"]')).toBeVisible();
      expect((await axe(page)).violations).toEqual([]);
    });

    test('Running CI is hidden when every row is running, and shown when mixed', async ({
      page,
    }) => {
      await open(page, path, {
        prs: [pr(1, kind, { ci: 'pending' }), pr(2, kind, { ci: 'pending' })],
      });
      const running = page.locator('.quick-pills [data-pill="running"]');
      await expect(running).toBeHidden();
      expect((await axe(page)).violations).toEqual([]);

      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await open(page, path, {
        prs: [pr(1, kind, { ci: 'pending' }), pr(2, kind)],
      });
      await expect(running).toBeVisible();
    });

    test('an active Running CI pill stays when every row is running', async ({
      page,
    }) => {
      await open(
        page,
        path,
        {
          prs: [pr(1, kind, { ci: 'pending' }), pr(2, kind, { ci: 'pending' })],
        },
        { pr: { quick: 'running' } },
      );
      await expect(page.locator('.filter-bar .quick-pills')).toBeVisible();
      await expect(
        page.locator('.quick-pills [data-pill="running"]'),
      ).toBeVisible();
      await expect(
        page.locator('.quick-pills [data-pill="running"]'),
      ).toHaveAttribute('aria-pressed', 'true');
    });
  });
}

test.describe('Issues: a control with one real choice', () => {
  test('the referencing pull request control is hidden when no issue has one, in the bar and the sheet', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page, '/issues.html', { issues: [issue(1), issue(2)] });
    const sheet = await openSheet(page);
    await expect(sheet.locator('.refs-group')).toBeHidden();
    expect((await axe(page)).violations).toEqual([]);
  });

  test('the control shows Any and both choices when both are backed', async ({
    page,
  }) => {
    await open(page, '/issues.html', {
      issues: [issue(1, { referencedByPullRequests: [prLink] }), issue(2)],
    });
    const group = page.locator('.filter-bar > .refs-group');
    await expect(group.locator('[data-ref="yes"]')).toBeVisible();
    await expect(group.locator('[data-ref="no"]')).toBeVisible();
    expect((await axe(page)).violations).toEqual([]);
  });

  test('the control stays for a lone active pick', async ({ page }) => {
    await open(
      page,
      '/issues.html',
      { issues: [issue(1), issue(2)] },
      { issue: { refBy: 'no' } },
    );
    await expect(page.locator('.filter-bar > .refs-group')).toBeVisible();
    await expect(
      page.locator('.filter-bar > .refs-group [data-ref="no"]'),
    ).toBeVisible();
    await expect(
      page.locator('.filter-bar > .refs-group [data-ref="no"]'),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('the forge pills are hidden when every issue is on one forge', async ({
    page,
  }) => {
    await open(page, '/issues.html', { issues: [issue(1), issue(2)] });
    await expect(
      page.locator('.quick-pills [data-pill="github"]'),
    ).toBeHidden();
    await expect(
      page.locator('.quick-pills [data-pill="forgejo"]'),
    ).toBeHidden();
    expect((await axe(page)).violations).toEqual([]);
  });
});

// Clearing a pick can hide the group that holds it. Focus must land on a
// control that is still there, not on the body.
const focusedTag = (page: Page) =>
  page.evaluate(() => document.activeElement?.tagName ?? '');

test.describe('Clearing the last pick of a group moves focus', () => {
  const allGithub = (kind: Kind, extra: Record<string, unknown> = {}) => [
    pr(1, kind, extra),
    pr(2, kind, extra),
  ];

  test('GitHub pill active, All pressed: focus goes to the title filter', async ({
    page,
  }) => {
    await open(
      page,
      '/pull-requests.html',
      { prs: allGithub('regular') },
      { shared: { forge: 'github' } },
    );
    const bar = page.locator('.filter-bar .quick-pills');
    await expect(bar.locator('[data-pill="github"]')).toBeVisible();
    await bar.locator('[data-pill="all"]').click();
    await expect(bar).toBeHidden();
    await expect(
      page.locator('.filter-bar .col-filter[data-col="title"]'),
    ).toBeFocused();
    expect(await focusedTag(page)).not.toBe('BODY');
  });

  test('Refs No active on rows that all have no refs, Any pressed: focus stays in the bar', async ({
    page,
  }) => {
    await open(
      page,
      '/pull-requests.html',
      { prs: allGithub('regular') },
      { pr: { refs: 'no' } },
    );
    const group = page.locator('.filter-bar > .refs-group');
    await group.locator('[data-ref="any"]').click();
    await expect(group).toBeHidden();
    expect(await focusedTag(page)).not.toBe('BODY');
    await expect(
      page.locator('.filter-bar .col-filter[data-col="title"]'),
    ).toBeFocused();
  });

  test('Refs No active, two forges, Any pressed: focus goes to the All pill', async ({
    page,
  }) => {
    await open(
      page,
      '/pull-requests.html',
      { prs: [pr(1, 'regular'), pr(2, 'regular', { forge: 'forgejo' })] },
      { pr: { refs: 'no' } },
    );
    const group = page.locator('.filter-bar > .refs-group');
    await group.locator('[data-ref="any"]').click();
    await expect(group).toBeHidden();
    await expect(
      page.locator('.filter-bar .quick-pills [data-pill="all"]'),
    ).toBeFocused();
  });

  test('Auto-merge On active on rows that all have it, Any pressed: focus goes to the title filter', async ({
    page,
  }) => {
    await open(
      page,
      '/pull-requests.html',
      { prs: allGithub('regular', { autoMergeEnabled: true }) },
      { pr: { autoMerge: 'on' } },
    );
    const group = page.locator('.filter-bar > .am-group');
    await group.locator('[data-am="any"]').click();
    await expect(group).toBeHidden();
    await expect(
      page.locator('.filter-bar .col-filter[data-col="title"]'),
    ).toBeFocused();
  });

  test('Running CI active on rows that all run, All pressed: focus goes to the title filter', async ({
    page,
  }) => {
    await open(
      page,
      '/pull-requests.html',
      { prs: allGithub('regular', { ci: 'pending' }) },
      { pr: { quick: 'running' } },
    );
    const bar = page.locator('.filter-bar .quick-pills');
    await bar.locator('[data-pill="all"]').click();
    await expect(bar).toBeHidden();
    await expect(
      page.locator('.filter-bar .col-filter[data-col="title"]'),
    ).toBeFocused();
  });

  test('in the phone sheet, focus stays inside the sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(
      page,
      '/pull-requests.html',
      { prs: allGithub('regular') },
      { pr: { refs: 'no' } },
    );
    const sheet = await openSheet(page);
    await sheet.locator('.refs-group [data-ref="any"]').click();
    await expect(sheet.locator('.refs-group')).toBeHidden();
    await expect(page.locator('#filter-sheet-close')).toBeFocused();
  });

  test('on a phone, a bar with no quick pill to offer shows no lone All', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page, '/pull-requests.html', {
      prs: [pr(1, 'regular'), pr(2, 'regular', { forge: 'forgejo' })],
    });
    // Both forge pills are offered, but they live in the sheet on a phone.
    await expect(page.locator('.filter-bar .quick-pills')).toBeHidden();
    expect((await axe(page)).violations).toEqual([]);
  });
});
