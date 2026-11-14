import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { serveChecks } from './checks-feed-helper';
import { test } from './server-fixture';

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
// Between the old 600px card breakpoint and the 761px phone rule.
const NARROW = { width: 700, height: 900, target: 44 } as const;
const TABLET = { width: 768, height: 900, target: 24 } as const;
const DESKTOP = { width: 1280, height: 900, target: 24 } as const;
const SIZES = [PHONE, NARROW, TABLET, DESKTOP];

type Sweep = { checked: number; offenders: string[] };

// Runs in the page, so it refers to nothing outside itself.
function sweepInPage([target, overlap, within]: readonly [
  number,
  boolean,
  string,
]): Sweep {
  const CONTROLS =
    'button, a[href], select, textarea, summary, input:not([type="hidden"]), [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [role="group"][tabindex="0"]';
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
    // Clipped away by an ancestor that is itself a pixel (a table header the
    // phone layout hides while keeping it for screen readers): nothing there
    // to touch.
    let clipped = false;
    for (let a = el.parentElement; a && a !== document.body; ) {
      const r = a.getBoundingClientRect();
      if (
        (r.width <= 1 || r.height <= 1) &&
        getComputedStyle(a).overflow !== 'visible'
      ) {
        clipped = true;
        break;
      }
      a = a.parentElement;
    }
    if (clipped) continue;
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

const sidewaysOverflow = (page: Page) =>
  page.evaluate(() => ({
    overflow:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
    laidOut: document.documentElement.clientWidth > 0,
  }));

// Re-reads the sideways overflow until the page fits, so a layout still
// settling doesn't count against it. A page that never fits returns the last
// overflow; one with no width at all never counts as fitting.
async function settledOverflow(page: Page): Promise<number> {
  let last = Number.POSITIVE_INFINITY;
  await expect
    .poll(
      async () => {
        const read = await sidewaysOverflow(page);
        last = read.laidOut ? read.overflow : Number.POSITIVE_INFINITY;
        return last <= 0;
      },
      { timeout: 3_000 },
    )
    .toBe(true)
    .catch(() => {});
  return last;
}

// Measures the open page at every size and adds what is too small to
// `problems`, so a test that visits several pages reports all of them.
async function sweepAll(
  page: Page,
  label: string,
  problems: string[],
  options: {
    overlap?: boolean;
    within?: string;
    sizes?: readonly (
      | typeof PHONE
      | typeof NARROW
      | typeof TABLET
      | typeof DESKTOP
    )[];
  } = {},
) {
  for (const size of options.sizes ?? SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    // Let the layout and any container-driven change settle.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const overflow = await settledOverflow(page);
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
  // Pills that draw a count per state (#2004, #2074, #2145, #3395). The
  // per-feature pill specs leave their 44px target to this sweep (#3500).
  makePR(10, {
    ci: 'pending',
    checks: { passed: 5, running: 2, waiting: 3, failed: 0 },
  }),
  makePR(11, {
    ci: 'failure',
    mergeStatus: 'unstable',
    checks: { passed: 8, running: 1, waiting: 2, failed: 3 },
  }),
  makePR(12, {
    ci: 'success',
    checks: { passed: 8, skipped: 2, running: 0, waiting: 0, failed: 0 },
  }),
  makePR(13, {
    forge: 'forgejo',
    repo: 'homelab/infra',
    ci: 'cancelled',
    mergeStatus: 'blocked',
    checks: { passed: 4, running: 0, waiting: 0, failed: 0, cancelled: 9 },
  }),
  // A Forgejo conflict only the forge's flag vouches for: a button pill (#3308).
  makePR(14, {
    forge: 'forgejo',
    repo: 'homelab/infra',
    mergeStatus: 'conflicting',
    conflictConfirmed: false,
    behind: true,
  }),
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

async function mockDashboard(
  page: Page,
  pullRequests = PULL_REQUESTS,
  repos: Record<string, unknown>[] = [],
) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
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
        repos,
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
    checks:
      status === 'failed'
        ? { passed: 8, running: 1, waiting: 2, failed: 3 }
        : { passed: 12, running: 0, waiting: 0, failed: 0 },
    finishedAt: ago(12),
    durationSeconds: 252,
    runUrl: `https://example.com/${fullName}/actions/runs/1`,
    staleSince: null,
  };
}

async function mockBranches(page: Page) {
  const branches = [
    branchRow('alrayyes/one', 'failed'),
    branchRow('alrayyes/two', 'passed'),
  ];
  await page.route('**/api/v1/main-branches*', (route: Route) =>
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

async function mockDetails(page: Page, descriptionText?: string) {
  await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text:
            descriptionText ??
            'This adds **structured** logging.\n\n- [ ] one\n- [x] two',
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

  // https://github.com/alrayyes/forge-dashboard/issues/3397
  // The pager only shows past one page of rows (25 by default), so the
  // sweep never reached it. 60 rows make three pages.
  test('pull requests: the pager under a long list', async ({ page }) => {
    const problems: string[] = [];
    await mockDashboard(
      page,
      Array.from({ length: 60 }, (_, i) => makePR(i + 1)),
    );
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/pull-requests.html');
    await ready(page, '#pr-rows .row');
    await expect(page.locator('#pr-pagination')).toBeVisible();
    await sweepAll(page, 'pager', problems, { within: '#pr-pagination' });
    // 320px with many pages still fits without sideways scroll.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByLabel('Results per page').selectOption({ index: 0 });
    expect(
      await settledOverflow(page),
      'pager @320 scrolls sideways',
    ).toBeLessThanOrEqual(0);
    expectNone(problems);
  });

  // https://github.com/alrayyes/forge-dashboard/issues/1857
  // The pop-up is a full-height sheet up to 480px and a centred dialog above
  // it, so 700px (under the 761px phone rule) is where the header Close and
  // the forge link used to fall short. The first row offers actions, so the
  // footer buttons are swept too.
  test('pull requests: the details dialog open', async ({ page }) => {
    const problems: string[] = [];
    await mockDashboard(
      page,
      PULL_REQUESTS.map((pr, i) =>
        i === 0
          ? {
              ...pr,
              allowedActions: [
                { action: 'merge', primary: true },
                { action: 'close' },
              ],
            }
          : pr,
      ),
    );
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

  // The Update all confirm: a tick box per row, Close and Update.
  test('pull requests: the Update all dialog open', async ({ page }) => {
    const problems: string[] = [];
    await mockDashboard(
      page,
      [1, 2].map((n) =>
        makePR(n, { allowedActions: [{ action: 'update_branch' }] }),
      ),
    );
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/pull-requests.html');
    await ready(page, '#pr-rows .row');
    await page.getByRole('button', { name: 'Update all (2)' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Update 2 pull requests?' }),
    ).toBeVisible();
    await sweepAll(page, 'update all dialog', problems);
    expectNone(problems);
  });

  // https://github.com/alrayyes/forge-dashboard/issues/3191
  // https://github.com/alrayyes/forge-dashboard/issues/3192
  // The sweep opened the details and Update all dialogs and missed this one:
  // its Close was 30px and its row links and Copy output were about 15px tall.
  // One Show output is expanded so the run-output Copy and Hide output buttons,
  // which share the row link class, are swept too.
  test('pull requests: the Pipeline checks dialog open', async ({ page }) => {
    const problems: string[] = [];
    const base = 'https://github.com/alrayyes/forge-dashboard/actions/runs/1';
    await mockDashboard(page);
    await serveChecks(page, () => [
      {
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        url: `${base}/job/1`,
        jobId: 1,
        required: true,
        failedStep: 'Run go test ./...',
        excerpt: 'FAIL: database is locked',
      },
      ...['lint', 'build', 'typecheck'].map((name, i) => ({
        name,
        status: 'completed',
        conclusion: 'success',
        url: `${base}/job/${i + 2}`,
        required: true,
      })),
      {
        name: 'e2e',
        status: 'in_progress',
        url: `${base}/job/5`,
        required: true,
      },
      {
        name: 'lighthouse',
        status: 'completed',
        conclusion: 'cancelled',
        url: `${base}/job/6`,
        required: false,
      },
      {
        name: 'auto-merge',
        status: 'queued',
        url: `${base}/job/7`,
        required: false,
      },
    ]);
    await page.route('**/api/v1/checks/log*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: 'step 1\nboom\n', truncated: false }),
      }),
    );
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/pull-requests.html');
    await ready(page, '#pr-rows .row');
    await page
      .locator('#pr-rows .row')
      .nth(1)
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog.locator('.pipeline-check').first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Show output: test' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Copy output: test' }),
    ).toBeVisible();
    // Phone widths only: from 761px the dialog keeps its density, and its
    // 16px row links are under the 24px floor the other sizes sweep for.
    await sweepAll(page, 'pipeline checks dialog', problems, {
      sizes: [PHONE, NARROW],
    });
    expectNone(problems);

    for (const size of [TABLET, DESKTOP]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      const closeButton = dialog.getByRole('button', {
        name: 'Close pipeline checks',
      });
      await expect
        .poll(
          async () => {
            const box = await closeButton.boundingBox();
            return (
              box !== null &&
              Math.abs(box.width - 30) < 0.5 &&
              Math.abs(box.height - 30) < 0.5
            );
          },
          { message: `close @${size.width} is 30 by 30` },
        )
        .toBe(true);
      const copyLink = dialog.getByRole('button', {
        name: 'Copy output: test',
      });
      await expect
        .poll(
          async () => {
            const box = await copyLink.boundingBox();
            return box !== null && Math.abs(box.height - 44) < 0.5;
          },
          { message: `copy output @${size.width} is a 44px icon button` },
        )
        .toBe(true);
    }
  });

  // https://github.com/alrayyes/forge-dashboard/issues/3891
  // The same dialog from 761px up, where it keeps its density: Copy output sat
  // under the excerpt with no height of its own and was 15px tall. Show output
  // is already a 44px button, and stays covered here.
  test('pull requests: the Pipeline checks dialog output buttons at desktop widths', async ({
    page,
  }) => {
    const problems: string[] = [];
    const base = 'https://github.com/alrayyes/forge-dashboard/actions/runs/1';
    await mockDashboard(page);
    await serveChecks(page, () => [
      {
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        url: `${base}/job/1`,
        jobId: 1,
        required: true,
        failedStep: 'Run go test ./...',
        excerpt: 'FAIL: database is locked',
      },
    ]);
    await page.setViewportSize({
      width: DESKTOP.width,
      height: DESKTOP.height,
    });
    await page.goto('/pull-requests.html');
    await ready(page, '#pr-rows .row');
    await page
      .locator('#pr-rows .row')
      .nth(1)
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog.locator('.pipeline-check').first()).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Show output: test' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Copy output: test' }),
    ).toBeVisible();
    await sweepAll(page, 'pipeline checks, output buttons', problems, {
      sizes: [PHONE, NARROW, TABLET, DESKTOP],
      within: '.pipeline-check',
    });
    expectNone(problems);
  });

  // https://github.com/alrayyes/forge-dashboard/issues/3891
  // The Show details toggle under the forge chip. It shows for a forge that
  // is starting up and has an error to explain.
  test('the forge health Show details toggle', async ({ page }) => {
    const problems: string[] = [];
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
            {
              forge: 'github',
              reachable: false,
              starting: true,
              repoCount: 1,
              errorKind: 'unreachable',
              error: 'dial tcp: i/o timeout',
              staleSince: ago(5),
            },
          ],
          pullRequests: PULL_REQUESTS,
          issues: ISSUES,
          repos: [],
          hiddenDrafts: 0,
        }),
      }),
    );
    await page.goto('/pull-requests.html');
    await expect(
      page.locator('#forge-health .forge-health-detail summary'),
    ).toBeVisible();
    await sweepAll(page, 'forge health', problems, {
      within: '#forge-health',
    });
    expectNone(problems);

    // The 24px reach is a hit area, not a taller box: the words stay where the
    // line sits, clear of the error line above, closed and open, and they sit
    // inside the control at phone width too.
    const textBox = () =>
      page.evaluate(() => {
        const summary = document.querySelector(
          '#forge-health .forge-health-detail summary',
        ) as HTMLElement;
        const error = document.querySelector(
          '#forge-health .forge-health-error',
        ) as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(summary);
        const text = range.getBoundingClientRect();
        const box = summary.getBoundingClientRect();
        return {
          aboveError: text.top - error.getBoundingClientRect().bottom,
          insideTop: text.top - box.top,
          insideBottom: box.bottom - text.bottom,
          top: text.top - error.getBoundingClientRect().top,
        };
      });
    for (const size of [DESKTOP, PHONE]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      const details = page.locator('#forge-health .forge-health-detail');
      for (const open of [false, true]) {
        await details.evaluate((el, o) => {
          (el as HTMLDetailsElement).open = o;
        }, open);
        const t = await textBox();
        const where = `@${size.width} ${open ? 'open' : 'closed'}`;
        expect(
          t.aboveError,
          `text clear of the error line ${where}`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          t.insideTop,
          `text inside the box ${where}`,
        ).toBeGreaterThanOrEqual(-0.5);
        expect(
          t.insideBottom,
          `text inside the box ${where}`,
        ).toBeGreaterThanOrEqual(-0.5);
        if (size === DESKTOP)
          // Unmoved from the 2px gap under the error line's own 15px line.
          expect(t.aboveError, `no gap added ${where}`).toBeLessThanOrEqual(3);
        else
          expect(
            Math.abs(t.insideTop - t.insideBottom),
            `text centred ${where}`,
          ).toBeLessThanOrEqual(1);
      }
    }
  });

  // https://github.com/alrayyes/forge-dashboard/issues/3891
  // The generated text of a dependency update sits behind a summary, which had
  // no height of its own from 761px up. Every width, not only 700.
  test('pull requests: the generated description toggle at every width', async ({
    page,
  }) => {
    const problems: string[] = [];
    await mockDashboard(page);
    await mockDetails(page, `Bumps x from 1 to 2.\n\n${'notes\n\n'.repeat(5)}`);
    await page.setViewportSize({
      width: DESKTOP.width,
      height: DESKTOP.height,
    });
    await page.goto('/bots.html');
    await ready(page, '#pr-rows .row');
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: /^#\d+ / })
      .click();
    const dialog = page.getByRole('dialog', { name: /^Pull request details/ });
    await expect(dialog.locator('.details-collapsed summary')).toBeVisible();
    await sweepAll(page, 'details dialog, collapsed text', problems, {
      within: '.details-collapsed',
    });
    expectNone(problems);
  });

  // https://github.com/alrayyes/forge-dashboard/issues/1867
  // Reaction pills are focusable (they name who reacted on focus), and the
  // generated text of a dependency pull request sits behind a summary. Both
  // fell short between 481 and 760px, as did Retry, which nothing opened.
  test('pull requests: the details dialog of a dependency update', async ({
    page,
  }) => {
    const problems: string[] = [];
    await mockDashboard(page);
    await mockDetails(page, `Bumps x from 1 to 2.\n\n${'notes\n\n'.repeat(5)}`);
    await page.setViewportSize({ width: NARROW.width, height: NARROW.height });
    await page.goto('/bots.html');
    await ready(page, '#pr-rows .row');
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: /^#\d+ / })
      .click();
    const dialog = page.getByRole('dialog', { name: /^Pull request details/ });
    await expect(dialog.locator('.details-collapsed summary')).toBeVisible();
    await expect(dialog.locator('.reaction-pill').first()).toBeVisible();
    await sweepAll(page, 'details dialog, collapsed text', problems, {
      sizes: [NARROW],
    });
    expectNone(problems);
  });

  test('pull requests: the details dialog when loading fails', async ({
    page,
  }) => {
    const problems: string[] = [];
    await mockDashboard(page);
    await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
      route.fulfill({ status: 500, body: 'boom' }),
    );
    await page.setViewportSize({ width: NARROW.width, height: NARROW.height });
    await page.goto('/pull-requests.html');
    await ready(page, '#pr-rows .row');
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: /^#\d+ / })
      .click();
    const retry = page.locator('.details-retry');
    await expect(retry).toBeVisible();
    await expect
      .poll(async () => {
        const box = await retry.boundingBox();
        return box !== null && box.height >= 44 && box.width >= 44;
      })
      .toBe(true);
    await sweepAll(page, 'details dialog, error', problems, {
      sizes: [NARROW],
    });
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
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
    await page.route('**/api/v1/dashboard*', (route: Route) =>
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
    // Branches is the home route; /branches.html is a 404 in this build.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('a.mb-repo').first()).toBeVisible();
    await sweepAll(page, '/ (branches)', problems, {
      sizes: [PHONE, NARROW, TABLET, DESKTOP],
    });
    await page.goto('/insights.html');
    await page.waitForLoadState('networkidle');
    await sweepAll(page, '/insights.html', problems);
    expectNone(problems);
  });

  test('branches: the repo link does not take the CI pill taps (#3362)', async ({
    page,
  }) => {
    await mockDashboard(page);
    await mockBranches(page);
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/');
    const pill = page.locator('.mb-row .ci-pill').first();
    await expect(pill).toBeVisible();
    // The pill's lowest pixel row, straight above the repo link's extension.
    // Measured and hit-tested together, so a layout still moving can't pair
    // an old box with a new page.
    await expect
      .poll(async () => {
        const box = await pill.boundingBox();
        if (!box || box.width <= 0 || box.height <= 0) return false;
        return page.evaluate(
          ([x, y]) =>
            document.elementFromPoint(x, y)?.closest('.ci-pill') != null,
          [box.x + box.width / 2, box.y + box.height - 0.5],
        );
      })
      .toBe(true);
  });
});

test.describe('hit areas on the pages that read the server (#1753)', () => {
  test('settings: every group', async ({ page }) => {
    const problems: string[] = [];
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    for (const group of [
      'display',
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

  // https://github.com/alrayyes/forge-dashboard/issues/1825
  // The sweep above loads Webhooks with no repos, so it never saw the table.
  test('webhooks with repos loaded, the whole page', async ({ page }) => {
    const problems: string[] = [];
    const repo = (name: string, extra: Record<string, unknown> = {}) => ({
      forge: 'github',
      fullName: `alrayyes/${name}`,
      url: `https://github.com/alrayyes/${name}`,
      hasWebhook: true,
      canManageWebhooks: true,
      ignored: false,
      ignoredPRs: false,
      ignoredIssues: false,
      autoUpdateBranch: false,
      rebaseBots: false,
      ...extra,
    });
    // A filter that keeps every repo, so Clear filters is enabled and swept.
    await page.route('**/api/v1/settings/filter-state', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ webhooks: { repo: 'alrayyes' } }),
          })
        : route.fulfill({ status: 204 }),
    );
    await mockDashboard(page, PULL_REQUESTS, [
      repo('one'),
      repo('two', { autoUpdateBranch: true, rebaseBots: true }),
      repo('three', { hasWebhook: false }),
      repo('four', { hasWebhook: false, canManageWebhooks: false }),
      repo('five', { ignored: true, ignoredPRs: true }),
    ]);
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/webhooks.html');
    await ready(page, '#webhooks-table tbody tr');
    await expect(
      page.getByRole('button', { name: 'Clear filters' }),
    ).toBeEnabled();
    await sweepAll(page, '/webhooks.html with repos', problems);
    expectNone(problems);
  });

  test('webhooks with repos and a filter set, so Clear filters is enabled', async ({
    page,
  }) => {
    const problems: string[] = [];
    await page.route('**/api/v1/settings/filter-state', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ webhooks: { repo: 'acme' } }),
          })
        : route.fulfill({ status: 204 }),
    );
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
    await page.route('**/api/v1/dashboard*', (route) =>
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
    // Scoped to the filter bar; the whole page is swept in the case above.
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

test.describe('hit areas on the sign-in page (#1753)', () => {
  test('login', async ({ page, context }) => {
    await context.clearCookies();
    const problems: string[] = [];
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await page.goto('/login.html');
    await page.waitForLoadState('networkidle');
    await sweepAll(page, '/login.html', problems);
    expectNone(problems);
  });
});

test.describe('axe keeps passing with the larger targets (#1753)', () => {
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
