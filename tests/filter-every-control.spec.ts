import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { pickedLabels, toggleLabels } from './label-filter-helper';
import { registerViaInvite } from './register-helper';

// #1620, acceptance criterion 1: a list, from a test, of which filter controls
// are remembered. For every control on Pull requests, Issues, Releases and Bots
// this sets a value and then reads it back four ways: after a client
// navigation away and back, after a full load away and back, after a reload,
// and after the filter cookie is deleted and the page reloaded (what a second
// browser sees: the server copy). The server copy is polled first each time,
// so the last step never races the 500 ms save (that ordering gap is a
// separate ticket, #1760, and nothing here depends on it).
//
// Controls that are deliberately not remembered get a negative assertion at
// the end. Branches is covered by main-branches-server-copy.spec.ts and
// Insights by filter-late-copy.spec.ts, so they are not repeated here.
// https://github.com/alrayyes/forge-dashboard/issues/1620

test.describe.configure({ mode: 'parallel' });

type Board = 'pulls' | 'issues' | 'releases' | 'bots';

const BOARDS: Record<
  Board,
  { url: string; name: string; rows: string; count: string; away: Board }
> = {
  pulls: {
    url: '/pull-requests.html',
    name: 'pull-requests',
    rows: '#pr-rows > .row',
    count: '#pr-count',
    away: 'issues',
  },
  issues: {
    url: '/issues.html',
    name: 'issues',
    rows: '#issue-rows > .row',
    count: '#issue-count',
    away: 'pulls',
  },
  releases: {
    url: '/releases.html',
    name: 'releases',
    rows: '#pr-rows > .row',
    count: '#pr-count',
    away: 'issues',
  },
  bots: {
    url: '/bots.html',
    name: 'bots',
    rows: '#pr-rows > .row',
    count: '#pr-count',
    away: 'issues',
  },
};

// Every filter choice exists on every board: two forges, two repos, authors,
// labels, every CI state, ready, needs review, review requested, conflicts and
// both auto-merge answers. Thirty-two rows per board, so the pager shows at the default 25.
function pr(n: number, kind: string | undefined, extra = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number: n,
    title: `Pull request ${n}`,
    url: `https://example.com/pull/${n}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [{ name: 'chore', color: '0e8a16' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    autoMergeEnabled: true,
    ...(kind ? { kind } : {}),
    ...extra,
  };
}

function prsFor(base: number, kind: string | undefined) {
  return [
    pr(base + 1, kind, { readyToMerge: true }),
    pr(base + 2, kind, {
      forge: 'forgejo',
      repo: 'acme/infra',
      author: 'dana',
      labels: [{ name: 'bug', color: 'd73a4a' }],
      ci: 'failure',
      mergeStatus: 'conflicting',
      autoMergeEnabled: false,
    }),
    pr(base + 3, kind, { ci: 'pending', needsReview: true }),
    pr(base + 4, kind, { reviewRequestedFromMe: true }),
    pr(base + 5, kind, { ci: 'none' }),
    ...Array.from({ length: 27 }, (_, i) => pr(base + 6 + i, kind)),
  ];
}

const PULLS = [
  ...prsFor(100, undefined),
  ...prsFor(200, 'release'),
  ...prsFor(300, 'dependency'),
];

const ISSUES = Array.from({ length: 32 }, (_, i) => ({
  forge: i === 1 ? 'forgejo' : 'github',
  repo: i === 1 ? 'acme/infra' : 'acme/app',
  number: i + 1,
  title: `Issue ${i + 1}`,
  url: `https://example.com/issues/${i + 1}`,
  author: i === 1 ? 'sam' : 'ryan',
  labels: [
    i === 1
      ? { name: 'docs', color: '0366d6' }
      : { name: 'bug', color: 'd73a4a' },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}));

// The count line shows a number once the first snapshot is drawn, even when
// the filters leave no rows (a title filter on the other board's list).
const loaded = (page: Page, board: Board) =>
  expect(page.locator(BOARDS[board].count)).toHaveText(/\d/);

async function open(page: Page, board: Board) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [
          { forge: 'github', reachable: true, repoCount: 1 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests: PULLS,
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
        hiddenPullRequests: 1,
      }),
    }),
  );
  await page.goto(BOARDS[board].url);
  await loaded(page, board);
}

const link = (page: Page, board: Board) =>
  page.locator(`.app-nav a[href="${BOARDS[board].url}"]`);

type Groups = Record<string, Record<string, string>>;

const serverCopy = async (page: Page): Promise<Groups> =>
  (await (await page.request.get('/api/settings/filter-state')).json()) ?? {};

const cookieCopy = async (page: Page): Promise<Groups> => {
  const c = (await page.context().cookies()).find(
    (x) => x.name === 'forge-board-filters',
  );
  return c ? JSON.parse(decodeURIComponent(c.value)) : {};
};

// The cookie alone: the saved copy is refused for the whole check, so a value
// that shows can only have come from the cookie read at first paint. (Waiting
// for the copy would let a broken cookie read pass, since expect retries.)
const COPY_URL = '**/api/settings/filter-state';
async function withoutServerCopy(page: Page, check: () => Promise<void>) {
  const refuse = (route: Route) =>
    route.request().method() === 'GET' ? route.abort() : route.fallback();
  await page.route(COPY_URL, refuse);
  try {
    await check();
  } finally {
    await page.unroute(COPY_URL, refuse);
  }
}

interface Control {
  name: string;
  boards: Board[];
  // Where the choice is stored, and as what.
  group: string;
  key: string;
  stored: V;
  set: (page: Page, board: Board) => Promise<unknown>;
  // Expects the control to show the choice.
  show: (page: Page, board: Board) => Promise<void>;
}

const PR_BOARDS: Board[] = ['pulls', 'releases', 'bots'];
const ALL: Board[] = ['pulls', 'issues', 'releases', 'bots'];
// The CI pills and a couple of controls are the same code on all three pull
// request boards, so Releases and Bots get the controls with the most moving
// parts rather than every pill.
const PULLS_ONLY: Board[] = ['pulls'];

// A value that is the same on every board, or one for Issues and one for the
// pull request boards (the two lists have different authors and labels).
type V = string | { issues: string; other: string };
const perBoard = (v: V, board: Board): string =>
  typeof v === 'string' ? v : board === 'issues' ? v.issues : v.other;

function select(
  name: string,
  selector: string,
  value: V,
  group: string,
  key: string,
  boards: Board[] = ALL,
): Control {
  return {
    name,
    boards,
    group,
    key,
    stored: value,
    set: (page, board) =>
      page.locator(selector).selectOption(perBoard(value, board)),
    show: (page, board) =>
      expect(page.locator(selector)).toHaveValue(perBoard(value, board)),
  };
}

function pill(name: string, id: string, boards: Board[]): Control {
  const forge = id === 'github' || id === 'forgejo';
  return {
    name: `${name} pill`,
    boards,
    group: forge ? 'shared' : 'pr',
    key: forge ? 'forge' : 'quick',
    stored: id,
    set: (page) => page.locator(`.quick-pills [data-pill="${id}"]`).click(),
    show: (page) =>
      expect(page.locator(`.quick-pills [data-pill="${id}"]`)).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
  };
}

function autoMerge(value: 'on' | 'off'): Control {
  const button = (page: Page) =>
    page.locator(`.am-group:not(.sheet-only) [data-am="${value}"]`);
  return {
    name: `auto-merge ${value}`,
    boards: value === 'on' ? PR_BOARDS : PULLS_ONLY,
    group: 'pr',
    key: 'autoMerge',
    stored: value,
    set: (page) => button(page).click(),
    show: (page) =>
      expect(button(page)).toHaveAttribute('aria-pressed', 'true'),
  };
}

function toggle(
  name: string,
  selector: string,
  key: string,
  boards: Board[],
): Control {
  return {
    name,
    boards,
    group: 'view',
    key,
    stored: '1',
    set: (page) => page.locator(selector).click(),
    show: (page) =>
      expect(page.locator(selector)).toHaveAttribute('aria-pressed', 'true'),
  };
}

const TITLE = '.filter-bar .col-filter[data-col="title"]';

const CONTROLS: Control[] = [
  pill('GitHub', 'github', ALL),
  pill('Forgejo', 'forgejo', [...PULLS_ONLY, 'issues']),
  pill('Failing CI', 'failing', PR_BOARDS),
  pill('Running CI', 'running', PULLS_ONLY),
  pill('Passing CI', 'passing', PULLS_ONLY),
  pill('No checks', 'no-checks', PULLS_ONLY),
  pill('Conflicts', 'conflicting', PULLS_ONLY),
  pill('Ready to Merge', 'ready', PULLS_ONLY),
  pill('Needs Review', 'needs-review', PULLS_ONLY),
  pill('Review requested from me', 'review-requested', PR_BOARDS),
  autoMerge('on'),
  autoMerge('off'),
  select(
    'repo select',
    '#shared-repo-select',
    'github:acme/app',
    'shared',
    'repo',
  ),
  select(
    'author select',
    '#shared-author-select',
    { issues: 'sam', other: 'dana' },
    'shared',
    'author',
  ),
  {
    name: 'label filter',
    boards: ALL,
    group: 'shared',
    key: 'label',
    stored: { issues: 'docs', other: 'bug' },
    set: (page, board) =>
      toggleLabels(page, board === 'issues' ? 'docs' : 'bug'),
    show: (page, board) =>
      expect
        .poll(() => pickedLabels(page))
        .toEqual([board === 'issues' ? 'docs' : 'bug']),
  },
  select('created select', '[data-col="created"]', '1440', 'shared', 'created'),
  select('updated select', '[data-col="updated"]', '1440', 'shared', 'updated'),
  select(
    'group-by select',
    '#shared-group-select',
    'repo',
    'shared',
    'groupBy',
  ),
  select('sort select', '#pr-sort-select', 'created', 'view', 'sort'),
  toggle('Show drafts', '#show-drafts-toggle', 'drafts', PR_BOARDS),
  toggle('Pause live updates', '#pause-updates-button', 'paused', ALL),
  {
    name: 'title text',
    boards: ALL,
    group: 'shared',
    key: 'title',
    stored: { issues: 'issue', other: 'pull' },
    set: (page, board) =>
      page.locator(TITLE).fill(board === 'issues' ? 'issue' : 'pull'),
    show: (page, board) =>
      expect(page.locator(TITLE)).toHaveValue(
        board === 'issues' ? 'issue' : 'pull',
      ),
  },
  {
    name: 'Hide Dependency Dashboard off',
    boards: ['issues'],
    group: 'issue',
    key: 'hideDependencyDashboard',
    stored: '',
    set: (page) => page.locator('#issue-hide-dependency-dashboard').uncheck(),
    show: (page) =>
      expect(
        page.locator('#issue-hide-dependency-dashboard'),
      ).not.toBeChecked(),
  },
  {
    name: 'hide titles matching (regex)',
    boards: ['issues'],
    group: 'issue',
    key: 'hideTitleRegex',
    stored: '^zzz',
    set: (page) => page.locator('#issue-hide-title-regex').fill('^zzz'),
    show: (page) =>
      expect(page.locator('#issue-hide-title-regex')).toHaveValue('^zzz'),
  },
];

for (const board of ALL) {
  test.describe(`${board}: every remembered control`, () => {
    for (const control of CONTROLS.filter((c) => c.boards.includes(board))) {
      test(`${control.name} survives leaving and coming back`, async ({
        page,
        request,
        baseURL,
      }) => {
        await registerViaInvite(
          page,
          request,
          baseURL,
          `every-control-${board}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          'Every Control',
        );
        await open(page, board);
        const b = BOARDS[board];
        const stored = perBoard(control.stored, board);

        await control.set(page, board);
        await control.show(page, board);

        // The server copy first, so nothing below races the debounce.
        await expect
          .poll(
            async () => (await serverCopy(page))[control.group]?.[control.key],
          )
          .toBe(stored);
        expect((await cookieCopy(page))[control.group]?.[control.key]).toBe(
          stored,
        );

        // Client navigation away and back.
        await link(page, b.away).click();
        await loaded(page, b.away);
        await link(page, board).click();
        await loaded(page, board);
        await control.show(page, board);

        // Full load away and back.
        await page.goto(BOARDS[b.away].url);
        await loaded(page, b.away);
        await page.goto(b.url);
        await loaded(page, board);
        await control.show(page, board);

        // Reload.
        await page.reload();
        await loaded(page, board);
        await control.show(page, board);

        // First paint from the cookie alone.
        await withoutServerCopy(page, async () => {
          await page.reload();
          await loaded(page, board);
          await control.show(page, board);
        });

        // A second browser: no cookie, only the server copy.
        await expect
          .poll(
            async () => (await serverCopy(page))[control.group]?.[control.key],
          )
          .toBe(stored);
        await page.context().clearCookies({ name: 'forge-board-filters' });
        await page.reload();
        await loaded(page, board);
        await control.show(page, board);
      });
    }
  });
}

// Deliberately not remembered (docs/live-updates.md): the page, the page size, the
// phone Filters sheet and the hidden-pull-request panel. Each is set, the page
// is reloaded, and the control is back at its default and the saved copies
// hold nothing for it.
test.describe('deliberately not remembered', () => {
  for (const board of ALL) {
    const b = BOARDS[board];
    const prefix = board === 'issues' ? 'issue' : 'pr';

    test(`${board}: page size and current page`, async ({
      page,
      request,
      baseURL,
    }) => {
      await registerViaInvite(
        page,
        request,
        baseURL,
        `every-control-size-${board}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        'Every Control Size',
      );
      await open(page, board);
      await expect(page.locator(`#${prefix}-pagination`)).toBeVisible();
      await page.locator(`#${prefix}-page-size`).selectOption('10');
      await page
        .locator(`#${prefix}-pagination-pages .pagination-page`, {
          hasText: '2',
        })
        .click();
      await expect(
        page.locator(`#${prefix}-pagination-pages .pagination-page.active`),
      ).toHaveText('2');
      // Something else gets saved, so the copies exist to be read.
      await page.locator('#pr-sort-select').selectOption('created');
      await expect
        .poll(async () => (await serverCopy(page)).view?.sort)
        .toBe('created');

      await page.reload();
      await loaded(page, board);
      await expect(page.locator(`#${prefix}-page-size`)).toHaveValue('25');
      await expect(
        page.locator(`#${prefix}-pagination-pages .pagination-page.active`),
      ).toHaveText('1');
      for (const copy of [await serverCopy(page), await cookieCopy(page)]) {
        expect(JSON.stringify(copy)).not.toMatch(/page|size/i);
      }
    });

    test(`${board}: the open Filters sheet on a phone`, async ({
      page,
      request,
      baseURL,
    }) => {
      await registerViaInvite(
        page,
        request,
        baseURL,
        `every-control-sheet-${board}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        'Every Control Sheet',
      );
      await page.setViewportSize({ width: 390, height: 800 });
      await open(page, board);
      await page.locator('#filters-button').click();
      await expect(page.locator('dialog#filter-sheet')).toBeVisible();

      await page.reload();
      await loaded(page, board);
      await expect(page.locator('dialog#filter-sheet')).toBeHidden();
    });
  }

  for (const board of PR_BOARDS) {
    test(`${board}: the hidden pull requests panel`, async ({
      page,
      request,
      baseURL,
    }) => {
      await registerViaInvite(
        page,
        request,
        baseURL,
        `every-control-hidden-${board}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        'Every Control Hidden',
      );
      await open(page, board);
      const toggle = page.locator('#hidden-prs-toggle');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      await page.reload();
      await loaded(page, board);
      await expect(page.locator('#hidden-prs-toggle')).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });
  }
});

// Webhooks: its own page with its own controls, saved as the `webhooks` group
// (the way Branches is). Same four reads as above. The page size and the
// current page stay unsaved, as on the other pages.
const WEBHOOKS_URL = '/webhooks.html';

const WEBHOOK_REPOS = [
  { forge: 'github', fullName: 'acme/app', hasWebhook: true },
  { forge: 'forgejo', fullName: 'acme/infra', hasWebhook: false },
  ...Array.from({ length: 28 }, (_, i) => ({
    forge: 'github',
    fullName: `acme/lib-${i + 1}`,
    hasWebhook: true,
  })),
].map((r) => ({
  ...r,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
  canManageWebhooks: true,
}));

async function openWebhooks(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos: WEBHOOK_REPOS,
      }),
    }),
  );
  await page.goto(WEBHOOKS_URL);
  await expect(page.locator('#webhooks-rows tr').first()).toBeVisible();
}

const forgeRadio = (page: Page, value: string) =>
  page.locator(`input[data-filter="forge"][value="${value}"]`);
const sortHeader = (page: Page, key: string) =>
  page.locator(`th:has([data-sort-key="${key}"])`);

interface WebhookControl {
  name: string;
  // Every key the control stores in the `webhooks` group.
  stored: Record<string, string>;
  set: (page: Page) => Promise<unknown>;
  show: (page: Page) => Promise<void>;
}

const WEBHOOK_CONTROLS: WebhookControl[] = [
  {
    name: 'Forgejo forge button',
    stored: { forge: 'forgejo' },
    set: (page) => forgeRadio(page, 'forgejo').check(),
    show: (page) => expect(forgeRadio(page, 'forgejo')).toBeChecked(),
  },
  {
    name: 'GitHub forge button',
    stored: { forge: 'github' },
    set: (page) => forgeRadio(page, 'github').check(),
    show: (page) => expect(forgeRadio(page, 'github')).toBeChecked(),
  },
  {
    name: 'repo search',
    stored: { repo: 'infra' },
    set: (page) => page.locator('#webhooks-repo-filter').fill('infra'),
    show: (page) =>
      expect(page.locator('#webhooks-repo-filter')).toHaveValue('infra'),
  },
  {
    name: 'status select',
    stored: { status: 'pending' },
    set: (page) =>
      page.locator('#webhooks-status-filter').selectOption('pending'),
    show: (page) =>
      expect(page.locator('#webhooks-status-filter')).toHaveValue('pending'),
  },
  {
    name: 'sort column',
    stored: { sort: 'hasWebhook', dir: 'asc' },
    set: (page) => page.locator('[data-sort-key="hasWebhook"]').click(),
    show: (page) =>
      expect(sortHeader(page, 'hasWebhook')).toHaveAttribute(
        'aria-sort',
        'ascending',
      ),
  },
  {
    name: 'sort direction',
    stored: { sort: 'fullName', dir: 'desc' },
    set: (page) => page.locator('[data-sort-key="fullName"]').click(),
    show: (page) =>
      expect(sortHeader(page, 'fullName')).toHaveAttribute(
        'aria-sort',
        'descending',
      ),
  },
];

const webhooksServer = async (page: Page) =>
  ((await serverCopy(page)).webhooks ?? {}) as Record<string, string>;
const webhooksCookie = async (page: Page) =>
  ((await cookieCopy(page)).webhooks ?? {}) as Record<string, string>;

test.describe('webhooks: every remembered control', () => {
  for (const control of WEBHOOK_CONTROLS) {
    test(`${control.name} survives leaving and coming back`, async ({
      page,
      request,
      baseURL,
    }) => {
      await registerViaInvite(
        page,
        request,
        baseURL,
        `every-control-webhooks-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        'Every Control Webhooks',
      );
      await openWebhooks(page);
      await control.set(page);
      await control.show(page);

      await expect
        .poll(() => webhooksServer(page))
        .toMatchObject(control.stored);
      expect(await webhooksCookie(page)).toMatchObject(control.stored);

      // Client navigation away and back.
      await link(page, 'issues').click();
      await loaded(page, 'issues');
      await page.locator(`.app-nav a[href="${WEBHOOKS_URL}"]`).click();
      await expect(page.locator('#webhooks-rows tr').first()).toBeVisible();
      await control.show(page);

      // Full load away and back.
      await page.goto(BOARDS.issues.url);
      await loaded(page, 'issues');
      await page.goto(WEBHOOKS_URL);
      await expect(page.locator('#webhooks-rows tr').first()).toBeVisible();
      await control.show(page);

      // Reload.
      await page.reload();
      await expect(page.locator('#webhooks-rows tr').first()).toBeVisible();
      await control.show(page);

      // First paint from the cookie alone.
      await withoutServerCopy(page, async () => {
        await page.reload();
        await expect(page.locator('#webhooks-rows tr').first()).toBeVisible();
        await control.show(page);
      });

      // A second browser: no cookie, only the server copy.
      await expect
        .poll(() => webhooksServer(page))
        .toMatchObject(control.stored);
      await page.context().clearCookies({ name: 'forge-board-filters' });
      await page.reload();
      await expect(page.locator('#webhooks-rows tr').first()).toBeVisible();
      await control.show(page);
    });
  }

  test('page size and current page are not remembered', async ({
    page,
    request,
    baseURL,
  }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      `every-control-webhooks-size-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'Every Control Webhooks Size',
    );
    await openWebhooks(page);
    await page.locator('#webhooks-page-size').selectOption('10');
    await page
      .locator('#webhooks-pagination-pages .pagination-page', { hasText: '2' })
      .click();
    await expect(
      page.locator('#webhooks-pagination-pages .pagination-page.active'),
    ).toHaveText('2');
    // Something else gets saved, so the copies exist to be read.
    await page.locator('#webhooks-status-filter').selectOption('confirmed');
    await expect
      .poll(async () => (await webhooksServer(page)).status)
      .toBe('confirmed');

    await page.reload();
    await expect(page.locator('#webhooks-rows tr').first()).toBeVisible();
    await expect(page.locator('#webhooks-page-size')).toHaveValue('25');
    await expect(
      page.locator('#webhooks-pagination-pages .pagination-page.active'),
    ).toHaveText('1');
    for (const copy of [
      await webhooksServer(page),
      await webhooksCookie(page),
    ]) {
      expect(JSON.stringify(copy)).not.toMatch(/page|size/i);
    }
  });
});
