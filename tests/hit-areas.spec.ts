import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { STORAGE_STATE_PATH as ADMIN_STORAGE_STATE } from './admin-global-setup';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// https://github.com/alrayyes/forge-dashboard/issues/1753
//
// Every control has a hit area of at least 24 by 24 px at every width (WCAG
// 2.2 success criterion 2.5.8), and at least 44 by 44 px on a phone, under
// 760 px, where a thumb is the input (2.5.5). Desktop keeps its density, so
// 44 does not apply from 761 px up. Links inline in prose are exempt, as the
// criterion allows.
//
// The hit area is what a pointer reaches, not the painted shape: it starts at
// the element's box and grows outwards while elementFromPoint still answers
// with the element (or its label, or a descendant), so a pseudo-element that
// extends the target counts and one that a neighbour covers does not. A
// second probe walks the element's own box and fails when a different control
// answers there, which is how an extended target that overlaps a neighbour
// shows up.

const PHONE = { width: 375, height: 800, target: 44 } as const;
const TABLET = { width: 768, height: 900, target: 24 } as const;
const DESKTOP = { width: 1280, height: 900, target: 24 } as const;
const SIZES = [PHONE, TABLET, DESKTOP];

type Sweep = { checked: number; offenders: string[] };

// Runs in the page, so it refers to nothing outside itself.
function sweepInPage([target, overlap, within]: readonly [
  number,
  boolean,
  string,
]): Sweep {
  const CONTROLS =
    'button, a[href], select, textarea, summary, input:not([type="hidden"]), [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"]';
  // Quarter pixels, and no slack beyond rounding: a hit area half a pixel
  // short of the target is short of it.
  const STEP = 0.25;
  const SLACK = 0.01;

  const modal = document.querySelector('dialog:modal');
  const scope: ParentNode =
    (within ? document.querySelector(within) : null) ?? modal ?? document;

  const nameOf = (el: Element) => {
    const text =
      el.getAttribute('aria-label') ||
      el.textContent?.trim().replace(/\s+/g, ' ') ||
      el.getAttribute('title') ||
      (el as HTMLInputElement).type ||
      '';
    const classes = [...el.classList]
      .filter((c) => !c.startsWith('svelte-'))
      .join('.');
    return `${el.tagName.toLowerCase()}${classes ? `.${classes}` : ''} "${text.slice(0, 32)}"`;
  };

  const owns = (el: Element, hit: Element | null) => {
    if (!hit) return false;
    if (el === hit || el.contains(hit)) return true;
    const labels = (el as HTMLInputElement).labels;
    if (labels && [...labels].some((l) => l === hit || l.contains(hit)))
      return true;
    return hit.closest('label')?.control === el;
  };

  const owned = (el: Element, x: number, y: number) =>
    owns(el, document.elementFromPoint(x, y));

  // A link inside a sentence is exempt. The footer's links and the nav are
  // not: they stand on their own line of controls.
  const inProse = (el: Element) => {
    if (el.tagName !== 'A') return false;
    if (el.closest('footer, nav, header')) return false;
    if (getComputedStyle(el).display !== 'inline') return false;
    const parent = el.parentElement;
    if (!parent) return false;
    let text = '';
    for (const node of parent.childNodes)
      if (node !== el && node.nodeType === Node.TEXT_NODE)
        text += node.textContent ?? '';
    return text.replace(/[\s·|,.()-]/g, '').length > 0;
  };

  const offenders: string[] = [];
  let checked = 0;

  for (const el of scope.querySelectorAll(CONTROLS)) {
    if (inProse(el)) continue;
    // A disabled checkbox or radio shows a state (a Markdown task list), it
    // is not something to hit.
    if (
      (el as HTMLInputElement).disabled &&
      ['checkbox', 'radio'].includes((el as HTMLInputElement).type)
    )
      continue;
    const style = getComputedStyle(el);
    if (style.visibility !== 'visible' || style.display === 'none') continue;
    let rect = el.getBoundingClientRect();
    // Visually hidden (a skip link, a native input behind a custom one).
    if (rect.width <= 1 || rect.height <= 1) continue;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    rect = el.getBoundingClientRect();
    checked++;

    // 1. Grow the box while the element keeps answering.
    const box = {
      l: rect.left,
      t: rect.top,
      r: rect.right,
      b: rect.bottom,
    };
    const along = (from: number, to: number) =>
      [0.15, 0.3, 0.5, 0.7, 0.85].map((f) => from + (to - from) * f);
    const freeColumn = (x: number) =>
      along(box.t, box.b).every((y) => owned(el, x, y));
    const freeRow = (y: number) =>
      along(box.l, box.r).every((x) => owned(el, x, y));
    let canLeft = true;
    let canRight = true;
    while (box.r - box.l < target - SLACK && (canLeft || canRight)) {
      if (canLeft) {
        if (freeColumn(box.l - STEP / 2)) box.l -= STEP;
        else canLeft = false;
      }
      if (box.r - box.l >= target - SLACK) break;
      if (canRight) {
        if (freeColumn(box.r + STEP / 2)) box.r += STEP;
        else canRight = false;
      }
    }
    let canUp = true;
    let canDown = true;
    while (box.b - box.t < target - SLACK && (canUp || canDown)) {
      if (canUp) {
        if (freeRow(box.t - STEP / 2)) box.t -= STEP;
        else canUp = false;
      }
      if (box.b - box.t >= target - SLACK) break;
      if (canDown) {
        if (freeRow(box.b + STEP / 2)) box.b += STEP;
        else canDown = false;
      }
    }
    const w = Math.round((box.r - box.l) * 10) / 10;
    const h = Math.round((box.b - box.t) * 10) / 10;
    if (w < target - SLACK || h < target - SLACK)
      offenders.push(`${nameOf(el)} hit area ${w}x${h}`);

    // 2. Another control answering inside this one's own box means a
    // neighbour's extended target overlaps it.
    const xs = [0.2, 0.5, 0.8].map((f) => rect.left + rect.width * f);
    const ys = [0.2, 0.5, 0.8].map((f) => rect.top + rect.height * f);
    if (!overlap) continue;
    for (const x of xs)
      for (const y of ys) {
        const hit = document.elementFromPoint(x, y);
        const other = hit?.closest(CONTROLS);
        const otherBox = other?.getBoundingClientRect();
        // A button inside the field's own frame (a copy button over a token
        // box) is part of the field, not a neighbour's target spilling on it.
        const inside =
          otherBox &&
          otherBox.left >= rect.left - 1 &&
          otherBox.right <= rect.right + 1 &&
          otherBox.top >= rect.top - 1 &&
          otherBox.bottom <= rect.bottom + 1;
        if (other && !inside && !owns(el, hit) && !other.contains(el)) {
          offenders.push(`${nameOf(el)} is covered by ${nameOf(other)}`);
          return { checked, offenders };
        }
      }
  }
  return { checked, offenders };
}

// Measures the open page at every size and adds what is too small to
// `problems`, so a test that visits several pages reports all of them.
async function sweepAll(
  page: Page,
  label: string,
  problems: string[],
  options: { overlap?: boolean; within?: string } = {},
) {
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    // Let the layout and any container-driven change settle.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    if (overflow > 0)
      problems.push(
        `${label} @${size.width}: scrolls sideways by ${overflow}px`,
      );
    const result = await page.evaluate(sweepInPage, [
      size.target,
      options.overlap ?? true,
      options.within ?? '',
    ] as const);
    expect(result.checked, `${label} @${size.width}: controls`).toBeGreaterThan(
      0,
    );
    // Sorted and de-duplicated, so a row repeated eight times reads once.
    const unique = [...new Set(result.offenders)];
    for (const o of unique)
      problems.push(`${label} @${size.width} (needs ${size.target}): ${o}`);
  }
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

function expectNone(problems: string[]) {
  expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
}

// ---- mocked data ----

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Change number ${number} with a reasonably long title that wraps`,
    url: `https://example.com/pulls/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    createdAt: ago(60 + number),
    updatedAt: ago(number),
    mergeStatus: 'mergeable',
    behind: false,
    ...overrides,
  };
}

const PULL_REQUESTS = [
  makePR(1),
  makePR(2, { ci: 'failure', mergeStatus: 'unstable' }),
  makePR(3, { behind: true }),
  makePR(4, { mergeStatus: 'conflicting' }),
  makePR(5, { author: 'dependabot[bot]', labels: [] }),
  makePR(6, { author: 'renovate[bot]', labels: [] }),
  makePR(7, {
    title: 'chore(main): release 1.2.3',
    labels: [{ name: 'autorelease: pending', color: 'ededed' }],
  }),
  makePR(8, { draft: true, ci: 'pending' }),
  makePR(9, { forge: 'forgejo', repo: 'homelab/infra', ci: 'none' }),
];

const ISSUES = [1, 2, 3].map((number) => ({
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'alrayyes',
  labels: [{ name: 'bug', color: 'd73a4a' }],
  createdAt: ago(100 + number),
  updatedAt: ago(number),
}));

async function mockDashboard(page: Page, pullRequests = PULL_REQUESTS) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [
          { forge: 'github', reachable: true, repoCount: 2 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests,
        issues: ISSUES,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

function branchRow(fullName: string, status: string) {
  return {
    forge: 'github',
    fullName,
    url: `https://example.com/${fullName}`,
    branch: 'main',
    status,
    commit: {
      sha: 'd98f3c2',
      subject: `fix: change in ${fullName}`,
      author: 'sre-dev',
      committedAt: ago(30),
    },
    failingJobs: status === 'failed' ? ['lint', 'e2e'] : [],
    finishedAt: ago(12),
    durationSeconds: 252,
    runUrl: `https://example.com/${fullName}/actions/runs/1`,
    stale: false,
    staleSince: null,
  };
}

async function mockBranches(page: Page) {
  const branches = [
    branchRow('alrayyes/one', 'failed'),
    branchRow('alrayyes/two', 'passed'),
  ];
  await page.route('**/api/main-branches*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
        branches,
        counts: { failed: 1, running: 0, passed: 1, none: 0 },
      }),
    }),
  );
}

const noReactions = {
  thumbsUp: { count: 2, logins: ['alice', 'bob'] },
  thumbsDown: { count: 0, logins: [] },
};

async function mockDetails(page: Page) {
  await page.route('**/api/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: 'This adds **structured** logging.\n\n- [ ] one\n- [x] two',
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions: noReactions,
        },
        comments: [
          {
            id: 'c1',
            author: { login: 'alice', avatarUrl: '' },
            createdAt: ago(120),
            updatedAt: null,
            edited: false,
            text: 'Looks good, see [the docs](https://example.com).',
            format: 'markdown',
            truncated: false,
            reactions: noReactions,
          },
        ],
        commentCount: 1,
        commentsTruncated: false,
        releaseNotes: null,
      }),
    }),
  );
}

async function ready(page: Page, selector: string) {
  await expect(page.locator(selector).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

// ---- the sweeps ----

test.describe('hit areas on the mocked boards (#1753)', () => {
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('pull requests: rows of every kind and state', async ({ page }) => {
    const problems: string[] = [];
    await mockDashboard(page);
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/pull-requests.html');
    await ready(page, '#pr-rows .row');
    await sweepAll(page, 'pull requests', problems);
    expectNone(problems);
  });

  test('pull requests: several short chips on one line', async ({ page }) => {
    const problems: string[] = [];
    const labels = ['ui', 'bug', 'ci'].map((name) => ({
      name,
      color: 'd73a4a',
    }));
    await mockDashboard(page, [makePR(1, { labels }), makePR(2, { labels })]);
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/pull-requests.html');
    await ready(page, '#pr-rows .row');
    await sweepAll(page, 'pull requests with three chips', problems);
    expectNone(problems);
  });

  test('pull requests: a More actions menu open', async ({ page }) => {
    const problems: string[] = [];
    await mockDashboard(page);
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/pull-requests.html');
    await ready(page, '#pr-rows .row');
    await page.getByRole('button', { name: 'More actions' }).first().click();
    await sweepAll(page, 'pull requests with a menu open', problems, {
      within: '.row-actions-popover',
    });
    expectNone(problems);
  });

  test('pull requests: the details dialog open', async ({ page }) => {
    const problems: string[] = [];
    await mockDashboard(page);
    await mockDetails(page);
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/pull-requests.html');
    await ready(page, '#pr-rows .row');
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: /^#\d+ / })
      .click();
    await expect(
      page.getByRole('dialog', { name: /^Pull request details/ }),
    ).toBeVisible();
    await expect(page.getByText('Looks good')).toBeVisible();
    await sweepAll(page, 'details dialog', problems);
    expectNone(problems);
  });

  test('pull requests: nothing to show', async ({ page }) => {
    const problems: string[] = [];
    await mockDashboard(page, []);
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/pull-requests.html');
    await page.waitForLoadState('networkidle');
    await sweepAll(page, 'pull requests, empty', problems);
    expectNone(problems);
  });

  test('pull requests: the dashboard answers with an error', async ({
    page,
  }) => {
    const problems: string[] = [];
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({ status: 500, body: 'boom' }),
    );
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/pull-requests.html');
    await page.waitForLoadState('networkidle');
    await sweepAll(page, 'pull requests, error', problems);
    expectNone(problems);
  });

  test('releases, bots and issues', async ({ page }) => {
    const problems: string[] = [];
    await mockDashboard(page);
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    for (const [path, row] of [
      ['/releases.html', '#pr-rows .row'],
      ['/bots.html', '#pr-rows .row'],
      ['/issues.html', '.row'],
    ] as const) {
      await page.goto(path);
      await ready(page, row);
      await sweepAll(page, path, problems);
    }
    expectNone(problems);
  });

  test('branches and insights', async ({ page }) => {
    const problems: string[] = [];
    await mockDashboard(page);
    await mockBranches(page);
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/branches.html');
    await page.waitForLoadState('networkidle');
    await sweepAll(page, '/branches.html', problems);
    await page.goto('/insights.html');
    await page.waitForLoadState('networkidle');
    await sweepAll(page, '/insights.html', problems);
    expectNone(problems);
  });
});

test.describe('hit areas on the pages that read the server (#1753)', () => {
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('settings: every group', async ({ page }) => {
    const problems: string[] = [];
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    for (const group of [
      'display',
      'sharing',
      'connections',
      'behaviour',
      'integrations',
    ]) {
      await page.goto(`/settings.html#${group}`);
      await page.waitForLoadState('networkidle');
      await sweepAll(page, `settings#${group}`, problems);
    }
    expectNone(problems);
  });

  test('webhooks, changelog, disclaimer and privacy', async ({ page }) => {
    const problems: string[] = [];
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    for (const path of [
      '/webhooks.html',
      '/changelog.html',
      '/disclaimer.html',
      '/privacy.html',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await sweepAll(page, path, problems);
    }
    expectNone(problems);
  });

  test('webhooks with repos and a filter set, so Clear filters is enabled', async ({
    page,
  }) => {
    const problems: string[] = [];
    await page.route('**/api/settings/filter-state', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ webhooks: { repo: 'acme' } }),
          })
        : route.fulfill({ status: 204 }),
    );
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [],
          pullRequests: [],
          issues: [],
          repos: [{ forge: 'github', fullName: 'acme/app', hasWebhook: true }],
        }),
      }),
    );
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/webhooks.html');
    await expect(
      page.getByRole('button', { name: 'Clear filters' }),
    ).toBeEnabled();
    // Scoped to the filter bar: the table's own sort and row buttons are
    // swept (and short of the target) separately from this control.
    await sweepAll(page, '/webhooks.html (filtered)', problems, {
      within: '#webhooks-filter-bar',
    });
    expectNone(problems);
  });

  test('404', async ({ page }) => {
    const problems: string[] = [];
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/no-such-page');
    await page.waitForLoadState('networkidle');
    await sweepAll(page, '404', problems);
    expectNone(problems);
  });
});

test.describe('hit areas on the admin page (#1753)', () => {
  test.use({ storageState: ADMIN_STORAGE_STATE });

  test('admin', async ({ page }) => {
    const problems: string[] = [];
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/admin.html');
    await page.waitForLoadState('networkidle');
    await sweepAll(page, '/admin.html', problems);
    expectNone(problems);
  });
});

test.describe('hit areas on the sign-in page (#1753)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('login', async ({ page }) => {
    const problems: string[] = [];
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/login.html');
    await page.waitForLoadState('networkidle');
    await sweepAll(page, '/login.html', problems);
    expectNone(problems);
  });
});

test.describe('axe keeps passing with the larger targets (#1753)', () => {
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('pull requests at 375 and the details dialog', async ({ page }) => {
    await mockDashboard(page);
    await mockDetails(page);
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/pull-requests.html');
    await ready(page, '#pr-rows .row');
    expect((await axe(page)).violations).toEqual([]);
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: /^#\d+ / })
      .click();
    await expect(page.getByText('Looks good')).toBeVisible();
    expect((await axe(page)).violations).toEqual([]);
  });
});
