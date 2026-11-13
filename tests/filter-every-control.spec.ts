import { expect, type Locator, type Page, type Route } from '@playwright/test';
import {
  pickedLabels,
  pickedValues,
  toggleLabels,
  togglePicks,
} from './label-filter-helper';
import { test } from './server-fixture';

// #1620, acceptance criterion 1: a list, from a test, of which filter controls
// are remembered. Pull requests, Issues and Webhooks each get one test that
// sets every control that combines in one round and reads it back three ways:
// after a client navigation away and back, after a reload with the saved copy
// refused (the cookie alone), and after the filter cookie is deleted and the
// page reloaded (what a second browser sees: the server copy). The server copy
// is polled first, so the last step never races the 500 ms save (that ordering
// gap is a separate ticket, #1760, and nothing here depends on it).
//
// What the journey no longer repeats lives below the browser. Which group and
// key each pill, select and toggle is saved under, and that every one comes
// back from the cookie, is web/src/lib/filters-cookie-roundtrip.test.ts. That
// the server keeps and returns every group and key as saved is
// TestFilterStatePut_ThenGet_RoundTripsEveryGroupAndKey in internal/api.
//
// Releases and Bots are the same Dashboard.svelte as Pull requests and store
// under the same keys, so they are not repeated (#3498). Controls that are
// deliberately not remembered get a negative assertion. Branches is covered by
// main-branches-server-copy.spec.ts and Insights by filter-late-copy.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/1620

// A control that is not there fails in seconds, naming its locator, instead of
// waiting out the 90 s test timeout.
test.use({ actionTimeout: 10_000 });

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
// labels, every CI state, ready, needs review, review requested, conflicts, out of
// date and both auto-merge answers. Thirty-two rows per board, so the pager shows at the default 25.
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
    pr(base + 4, kind, { reviewRequestedFromMe: true, behind: true }),
    pr(base + 5, kind, { ci: 'none' }),
    // Two more acme/infra rows. The combined round picks the repo, then the
    // author, then the label, and a pick filter with one choice is hidden
    // (#3517). After the repo the author pool must still hold two people
    // (dana, erin), and after dana the label pool two labels (bug, docs).
    pr(base + 6, kind, {
      forge: 'forgejo',
      repo: 'acme/infra',
      author: 'dana',
      labels: [{ name: 'docs', color: '0366d6' }],
    }),
    pr(base + 7, kind, {
      forge: 'forgejo',
      repo: 'acme/infra',
      author: 'erin',
      labels: [{ name: 'bug', color: 'd73a4a' }],
    }),
    // One filler row has auto-merge off too, so the pill paired with Off still
    // matches only some of that pool and stays offered (#3669).
    ...Array.from({ length: 25 }, (_, i) =>
      pr(base + 8 + i, kind, i === 0 ? { autoMergeEnabled: false } : {}),
    ),
  ];
}

const PULLS = [
  ...prsFor(100, undefined),
  ...prsFor(200, 'release'),
  ...prsFor(300, 'dependency'),
];

// Issues 2, 3 and 4 are acme/infra too, for the same reason as the extra pull
// request rows: after the repo the author pool holds sam and tess, and after
// sam the label pool holds docs and bug, so no pick filter is hidden (#3517)
// when the combined round reaches it.
const INFRA = new Set([1, 2, 3]);
const ISSUES = Array.from({ length: 32 }, (_, i) => ({
  forge: INFRA.has(i) ? 'forgejo' : 'github',
  repo: INFRA.has(i) ? 'acme/infra' : 'acme/app',
  number: i + 1,
  title: `Issue ${i + 1}`,
  url: `https://example.com/issues/${i + 1}`,
  author: i === 1 || i === 3 ? 'sam' : i === 2 ? 'tess' : 'ryan',
  labels: [
    i === 1 || i === 2
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
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
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
        pullRequests: PULLS,
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 1,
        hiddenDraftsByPage: { pullRequests: 1, releases: 0, bots: 0 },
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
  (await (await page.request.get('/api/v1/settings/filter-state')).json()) ??
  {};

const cookieCopy = async (page: Page): Promise<Groups> => {
  const c = (await page.context().cookies()).find(
    (x) => x.name === 'forge-board-filters',
  );
  return c ? JSON.parse(decodeURIComponent(c.value)) : {};
};

// The cookie alone: the saved copy is refused for the whole check, so a value
// that shows can only have come from the cookie read at first paint. (Waiting
// for the copy would let a broken cookie read pass, since expect retries.)
const COPY_URL = '**/api/v1/settings/filter-state';
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

// Where a choice is stored, and as what.
interface Stored {
  group: string;
  key: string;
  value: string;
}

interface Control {
  name: string;
  stored: Stored[];
  set: (page: Page) => Promise<unknown>;
  // Expects the control to show the choice.
  show: (page: Page) => Promise<void>;
}

function select(
  name: string,
  selector: string,
  value: string,
  group: string,
  key: string,
): Control {
  return {
    name,
    stored: [{ group, key, value }],
    set: (page) => page.locator(selector).selectOption(value),
    show: (page) => expect(page.locator(selector)).toHaveValue(value),
  };
}

// The pill groups combine (#3734), so a round starts with every group but the
// one it sets back on All, or an earlier round's pick could leave the next
// pill nothing to show.
async function resetPills(page: Page, except = '') {
  for (const group of ['forge', 'ci', 'merge', 'review']) {
    if (group === except) continue;
    const all = page.locator(
      `.quick-pills[data-group="${group}"] [data-pill="all"]`,
    );
    if (
      (await all.isVisible()) &&
      (await all.getAttribute('aria-pressed')) === 'false'
    )
      await all.click();
  }
}

function pill(name: string, id: string): Control {
  const forge = id === 'github' || id === 'forgejo';
  const group = forge
    ? 'forge'
    : ['failing', 'running', 'passing', 'no-checks'].includes(id)
      ? 'ci'
      : ['conflicting', 'out-of-date'].includes(id)
        ? 'merge'
        : 'review';
  return {
    name: `${name} pill`,
    stored: [
      {
        group: forge ? 'shared' : 'pr',
        key: forge ? 'forge' : group,
        value: id,
      },
    ],
    set: async (page) => {
      await resetPills(page, group);
      await page.locator(`.quick-pills [data-pill="${id}"]`).click();
    },
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
    stored: [{ group: 'pr', key: 'autoMerge', value }],
    // Off is only offered while it would show something, which an earlier
    // pill can rule out, so the pill goes back to All first.
    set: async (page) => {
      await resetPills(page);
      await button(page).click();
    },
    show: (page) =>
      expect(button(page)).toHaveAttribute('aria-pressed', 'true'),
  };
}

function toggle(name: string, selector: string, key: string): Control {
  return {
    name,
    stored: [{ group: 'view', key, value: '1' }],
    set: (page) => page.locator(selector).click(),
    show: (page) =>
      expect(page.locator(selector)).toHaveAttribute('aria-pressed', 'true'),
  };
}

const TITLE = '.filter-bar .col-filter[data-col="title"]';

// The controls that combine, set together in one round. The picks
// narrow to forgejo acme/infra rows, which still offer two authors and labels.
function combined(board: Board): Control[] {
  const issues = board === 'issues';
  const author = issues ? 'forgejo:sam' : 'forgejo:dana';
  const label = issues ? 'docs' : 'bug';
  const title = issues ? 'issue' : 'pull';
  const issueOnly: Control[] = [
    {
      name: 'Hide Dependency Dashboard off',
      stored: [{ group: 'issue', key: 'hideDependencyDashboard', value: '' }],
      set: (page) => page.locator('#issue-hide-dependency-dashboard').uncheck(),
      show: (page) =>
        expect(
          page.locator('#issue-hide-dependency-dashboard'),
        ).not.toBeChecked(),
    },
    {
      name: 'hide titles matching (regex)',
      stored: [{ group: 'issue', key: 'hideTitleRegex', value: '^zzz' }],
      set: (page) => page.locator('#issue-hide-title-regex').fill('^zzz'),
      show: (page) =>
        expect(page.locator('#issue-hide-title-regex')).toHaveValue('^zzz'),
    },
  ];
  // The title goes first: the picks after it can leave one row, and the box
  // is hidden over one row unless it holds text (#3823).
  return [
    {
      name: 'title text',
      stored: [{ group: 'shared', key: 'title', value: title }],
      // The rounds before this one leave a pill (and auto-merge) on, which can
      // leave one row and hide the box. Widen first.
      set: async (page) => {
        await resetPills(page);
        if (!issues)
          await page
            .locator('.am-group:not(.sheet-only) [data-am="any"]')
            .click();
        await page.locator(TITLE).fill(title);
      },
      show: (page) => expect(page.locator(TITLE)).toHaveValue(title),
    },
    {
      name: 'repo filter',
      stored: [{ group: 'shared', key: 'repo', value: 'forgejo:acme/infra' }],
      // The rounds before this one leave a pill (and auto-merge) on that
      // narrow the data to one repo, which hides the repo filter. Widen first.
      set: async (page) => {
        await resetPills(page);
        if (!issues)
          await page
            .locator('.am-group:not(.sheet-only) [data-am="any"]')
            .click();
        await togglePicks(page, 'repo', 'forgejo:acme/infra');
      },
      show: (page) =>
        expect
          .poll(() => pickedValues(page, 'repo'))
          .toEqual(['forgejo:acme/infra']),
    },
    {
      name: 'author filter',
      stored: [{ group: 'shared', key: 'author', value: author }],
      set: (page) => togglePicks(page, 'author', author),
      show: (page) =>
        expect.poll(() => pickedValues(page, 'author')).toEqual([author]),
    },
    {
      name: 'label filter',
      stored: [{ group: 'shared', key: 'label', value: label }],
      set: (page) => toggleLabels(page, label),
      show: (page) => expect.poll(() => pickedLabels(page)).toEqual([label]),
    },
    select(
      'created select',
      '[data-col="created"]',
      '1440',
      'shared',
      'created',
    ),
    select(
      'updated select',
      '[data-col="updated"]',
      '1440',
      'shared',
      'updated',
    ),
    select(
      'group-by select',
      '#shared-group-select',
      'repo',
      'shared',
      'groupBy',
    ),
    select('sort select', '#pr-sort-select', 'created', 'view', 'sort'),
    ...(issues ? [] : [toggle('Show drafts', '#show-drafts-toggle', 'drafts')]),
    {
      name: 'Pause live updates',
      stored: [{ group: 'view', key: 'paused', value: '1' }],
      set: (page) => page.locator('#pause-updates-button').click(),
      show: (page) =>
        expect(page.locator('.live-control')).toContainText('Paused'),
    },
    ...(issues ? issueOnly : []),
  ];
}

// A round is the controls set together, then read back. The combined round
// comes last, since its picks would leave a pill or the Off answer nothing to
// show. On the pull request board that Off answer and one pill (a pill and the
// answer both offered over the full list) get the one round before it.
const PULLS_ROUNDS: Control[][] = [
  [autoMerge('off'), pill('Failing', 'failing')],
  combined('pulls'),
];
const ISSUES_ROUNDS: Control[][] = [combined('issues')];

// The page a round is read back on, and where it goes to leave and come back.
interface Surface {
  link: (page: Page) => Locator;
  awayLink: (page: Page) => Locator;
  ready: (page: Page) => Promise<unknown>;
  awayReady: (page: Page) => Promise<unknown>;
}

const webhooksRows = (page: Page) => page.locator('#webhooks-rows tr').first();

function boardSurface(board: Board): Surface {
  const away = BOARDS[board].away;
  return {
    link: (page) => link(page, board),
    awayLink: (page) => link(page, away),
    ready: (page) => loaded(page, board),
    awayReady: (page) => loaded(page, away),
  };
}

const WEBHOOKS_URL = '/webhooks.html';

const webhooksSurface: Surface = {
  link: (page) => page.locator(`.app-nav a[href="${WEBHOOKS_URL}"]`),
  awayLink: (page) => link(page, 'issues'),
  ready: (page) => expect(webhooksRows(page)).toBeVisible(),
  awayReady: (page) => loaded(page, 'issues'),
};

async function readBackRound(page: Page, s: Surface, round: Control[]) {
  const names = round.map((c) => c.name).join(' + ');
  await test.step(`set ${names}`, async () => {
    for (const control of round) await control.set(page);
  });
  const showAll = async (where: string) => {
    for (const control of round) {
      await test.step(`${control.name} ${where}`, () => control.show(page));
    }
  };
  const saved = async (where: string) => {
    for (const control of round) {
      for (const { group, key, value } of control.stored) {
        await expect
          .poll(async () => (await serverCopy(page))[group]?.[key], {
            message: `${control.name}: server copy ${where}`,
          })
          .toBe(value);
      }
    }
  };
  await showAll('shows the choice');

  // The server copy first, so nothing below races the debounce.
  await saved('after the save');
  for (const control of round) {
    for (const { group, key, value } of control.stored) {
      expect(
        (await cookieCopy(page))[group]?.[key],
        `${control.name}: cookie copy`,
      ).toBe(value);
    }
  }

  // Client navigation away and back.
  await s.awayLink(page).click();
  await s.awayReady(page);
  await s.link(page).click();
  await s.ready(page);
  await showAll('after client navigation');

  // First paint from the cookie alone.
  await withoutServerCopy(page, async () => {
    await page.reload();
    await s.ready(page);
    await showAll('from the cookie alone');
  });

  // A second browser: no cookie, only the server copy.
  await page.context().clearCookies({ name: 'forge-board-filters' });
  await page.reload();
  await s.ready(page);
  await showAll('from the server copy alone');
}

// Deliberately not remembered (docs/live-updates.md): the page, the page size,
// the phone Filters sheet and the hidden-pull-request panel. Each is set, the
// page is reloaded, and the control is back at its default and the saved
// copies hold nothing for it. These run first, on the unfiltered list, since
// the pager needs more than one page of rows.
async function notRemembered(page: Page, board: Board) {
  const prefix = board === 'issues' ? 'issue' : 'pr';

  await test.step('page size and current page', async () => {
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

  if (board === 'pulls') {
    await test.step('the hidden pull requests panel', async () => {
      const panel = page.locator('#hidden-prs-toggle');
      await panel.click();
      await expect(panel).toHaveAttribute('aria-expanded', 'true');

      await page.reload();
      await loaded(page, board);
      await expect(page.locator('#hidden-prs-toggle')).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });
  }

  await test.step('the open Filters sheet on a phone', async () => {
    const size = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.locator('#filters-button').click();
    await expect(page.locator('dialog#filter-sheet')).toBeVisible();

    await page.reload();
    await loaded(page, board);
    await expect(page.locator('dialog#filter-sheet')).toBeHidden();
    if (size) await page.setViewportSize(size);
  });
}

const BOARD_ROUNDS: Record<'pulls' | 'issues', Control[][]> = {
  pulls: PULLS_ROUNDS,
  issues: ISSUES_ROUNDS,
};

for (const board of ['pulls', 'issues'] as const) {
  test(`${board}: every remembered control survives leaving and coming back`, async ({
    page,
  }) => {
    // Two rounds of three reads and the not-remembered checks; the default 30 s
    // is too close under load.
    test.setTimeout(60_000);
    await open(page, board);
    await notRemembered(page, board);
    for (const round of BOARD_ROUNDS[board]) {
      await readBackRound(page, boardSurface(board), round);
    }
  });
}

// Releases and Bots are Pull requests with a `view` prop, so one control each
// is enough to show their pages read the same saved keys back.
for (const board of ['releases', 'bots'] as const) {
  test(`${board}: a remembered control survives leaving and coming back`, async ({
    page,
  }) => {
    await open(page, board);
    await readBackRound(page, boardSurface(board), [
      pill('Failing', 'failing'),
    ]);
  });
}

// Webhooks: its own page with its own controls, saved as the `webhooks` group
// (the way Branches is). Same reads as above. The page size and the current
// page stay unsaved, as on the other pages.
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
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
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
  await expect(webhooksRows(page)).toBeVisible();
}

const forgeRadio = (page: Page, value: string) =>
  page.locator(`input[data-filter="forge"][value="${value}"]`);
const sortHeader = (page: Page, key: string) =>
  page.locator(`th:has([data-sort-key="${key}"])`);

const webhooksStored = (stored: Record<string, string>): Stored[] =>
  Object.entries(stored).map(([key, value]) => ({
    group: 'webhooks',
    key,
    value,
  }));

const webhookForge = (name: string, value: string): Control => ({
  name,
  stored: webhooksStored({ forge: value }),
  set: (page) => forgeRadio(page, value).check(),
  show: (page) => expect(forgeRadio(page, value)).toBeChecked(),
});

const webhookSort = (
  name: string,
  sort: string,
  dir: 'asc' | 'desc',
): Control => ({
  name,
  stored: webhooksStored({ sort, dir }),
  set: (page) => page.locator(`[data-sort-key="${sort}"]`).click(),
  show: (page) =>
    expect(sortHeader(page, sort)).toHaveAttribute(
      'aria-sort',
      dir === 'asc' ? 'ascending' : 'descending',
    ),
});

const WEBHOOK_ROUNDS: Control[][] = [
  [
    webhookForge('Forgejo forge button', 'forgejo'),
    {
      name: 'repo search',
      stored: webhooksStored({ repo: 'infra' }),
      set: (page) => page.locator('#webhooks-repo-filter').fill('infra'),
      show: (page) =>
        expect(page.locator('#webhooks-repo-filter')).toHaveValue('infra'),
    },
    {
      name: 'status select',
      stored: webhooksStored({ status: 'pending' }),
      set: (page) =>
        page.locator('#webhooks-status-filter').selectOption('pending'),
      show: (page) =>
        expect(page.locator('#webhooks-status-filter')).toHaveValue('pending'),
    },
    webhookSort('sort column', 'hasWebhook', 'asc'),
  ],
];

test('webhooks: every remembered control survives leaving and coming back', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openWebhooks(page);

  await test.step('page size and current page are not remembered', async () => {
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
      .poll(async () => (await serverCopy(page)).webhooks?.status)
      .toBe('confirmed');

    await page.reload();
    await expect(webhooksRows(page)).toBeVisible();
    await expect(page.locator('#webhooks-page-size')).toHaveValue('25');
    await expect(
      page.locator('#webhooks-pagination-pages .pagination-page.active'),
    ).toHaveText('1');
    for (const copy of [await serverCopy(page), await cookieCopy(page)]) {
      expect(JSON.stringify(copy.webhooks)).not.toMatch(/page|size/i);
    }
    // Back to every status, so the forge buttons are offered again.
    await page.locator('#webhooks-status-filter').selectOption('');
  });

  for (const round of WEBHOOK_ROUNDS) {
    await readBackRound(page, webhooksSurface, round);
  }
});
