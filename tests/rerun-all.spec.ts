import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// "Rerun failed checks" on the Pull requests and Bots pages (#3236). Who may
// rerun and the wording are pinned in rerun-all.test.ts; these cases pin the
// wiring: the header button, the two groups of the dialog, the requests made
// (none for a row that can't run), and the summary.

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Change number ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'failure',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: false,
    allowedActions: [{ action: 'rerun_checks' }],
    ...overrides,
  };
}

const bot = (number: number, overrides: Record<string, unknown> = {}) =>
  pr(number, { author: 'dependabot[bot]', ...overrides });

// What GET .../rerunnable answers per pull request number.
type Probes = Record<number, { rerunnable: boolean; reason?: string }>;

async function open(
  page: Page,
  path: '/pull-requests.html' | '/bots.html',
  pullRequests: ReturnType<typeof pr>[],
  probes: Probes,
  opts: {
    forges?: Record<string, unknown>[];
    refuse?: Record<number, string>;
    hidden?: number;
    // Probe answers that fail with a 500 before the real ones.
    probeFailures?: number;
    // A probe waits for its promise before it answers (by pull request number).
    hold?: Record<number, Promise<void>>;
    // Pull requests whose held probe answers 500.
    failHeld?: number[];
  } = {},
) {
  const posts: number[] = [];
  const probed: number[] = [];
  const snapshot = () =>
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: opts.forges ?? [
        { forge: 'github', reachable: true, repoCount: 1 },
      ],
      pullRequests,
      issues: [],
      repos: [],
      hiddenDrafts: 0,
      hiddenPullRequests: opts.hidden ?? 0,
    });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route(/\/api\/v1\/dashboard(\/refresh)?(\?.*)?$/, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    }),
  );
  await page.route('**/api/v1/pull-requests/rerunnable*', (route: Route) => {
    const number = Number(
      new URL(route.request().url()).searchParams.get('number'),
    );
    probed.push(number);
    const held = opts.hold?.[number];
    if (held && probed.filter((n) => n === number).length === 1) {
      return held.then(() =>
        opts.failHeld?.includes(number)
          ? route.fulfill({ status: 500, body: 'boom' })
          : route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(probes[number] ?? { rerunnable: true }),
            }),
      );
    }
    if (probed.length <= (opts.probeFailures ?? 0))
      return route.fulfill({ status: 500, body: 'boom' });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(probes[number] ?? { rerunnable: true }),
    });
  });
  await page.route('**/api/v1/pull-requests/rerun-checks', (route: Route) => {
    const { number } = route.request().postDataJSON();
    posts.push(number);
    const message = opts.refuse?.[number];
    if (message)
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'unknown', message }),
      });
    return route.fulfill({ status: 204 });
  });
  await page.goto(path);
  return { posts, probed };
}

const mixed = [
  pr(1),
  pr(2),
  pr(3, { ci: 'success', allowedActions: [] }),
  pr(4),
];
const mixedProbes: Probes = {
  2: {
    rerunnable: false,
    reason: 'no failed GitHub Actions job to rerun on this pull request',
  },
};

for (const [name, path, rows] of [
  ['Pull requests', '/pull-requests.html', mixed],
  [
    'Bots',
    '/bots.html',
    mixed.map((r) => ({ ...r, author: 'dependabot[bot]' })),
  ],
] as const) {
  test.describe(name, () => {
    test('the button counts the failing rows and asks the forge nothing until it is pressed', async ({
      page,
    }) => {
      const { probed } = await open(page, path, [...rows], mixedProbes);
      await expect(
        page.getByRole('button', { name: 'Rerun failed checks (3)' }),
      ).toBeVisible();
      await page.waitForTimeout(300);
      expect(probed).toEqual([]);
    });

    test('the dialog sorts the rows, and confirming asks only the first group', async ({
      page,
    }) => {
      const { posts } = await open(page, path, [...rows], mixedProbes, {
        refuse: { 4: 'The run is too old to rerun.' },
      });
      const rowTop = (await page.locator('.row').first().boundingBox())?.y;
      await page
        .getByRole('button', { name: 'Rerun failed checks (3)' })
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Rerun 2 pull requests?',
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole('heading', { name: 'Will rerun (2)' }),
      ).toBeVisible();
      await expect(
        dialog.getByRole('heading', { name: "Can't rerun (1)" }),
      ).toBeVisible();
      const will = dialog.locator('#rerun-all-list > li');
      await expect(will).toHaveCount(2);
      await expect(will.nth(0)).toContainText('acme/app #1');
      await expect(will.nth(0)).toContainText('Change number 1');
      const left = dialog.locator('#rerun-all-left-out-list > li');
      await expect(left).toHaveCount(1);
      await expect(left.first()).toContainText('#2');
      await expect(left.first()).toContainText(
        "Failing on an external CI, or no job ran. It can't be rerun from here.",
      );

      await dialog
        .getByRole('button', { name: 'Rerun 2 pull requests' })
        .click();
      await expect(page.locator('#rerun-all-status')).toHaveText(
        'Rerun queued for 1 of 2. 1 refused.',
      );
      expect(posts).toEqual([1, 4]);
      // The refusal is told in the dialog, so no row moves.
      const refusal = page.getByRole('dialog', {
        name: 'Rerun queued for 1 of 2. 1 refused.',
      });
      await expect(refusal.locator('#rerun-all-result')).toContainText(
        'acme/app #4: The run is too old to rerun.',
      );
      await refusal.getByRole('button', { name: 'Close' }).click();
      await expect(refusal).toBeHidden();
      expect((await page.locator('.row').first().boundingBox())?.y).toBe(
        rowTop,
      );
    });
  });
}

test('with no failing row the control is not there', async ({ page }) => {
  await open(
    page,
    '/pull-requests.html',
    [pr(1, { ci: 'success', allowedActions: [] })],
    {},
  );
  await expect(page.locator('.row').first()).toBeVisible();
  await expect(page.locator('#rerun-all-button')).toBeHidden();
});

test('when no failing row can run the dialog says so and sends nothing', async ({
  page,
}) => {
  const none = { rerunnable: false, reason: 'no failed GitHub Actions job x' };
  const { posts } = await open(
    page,
    '/pull-requests.html',
    [pr(1), pr(2), pr(3)],
    { 1: none, 2: none, 3: none },
  );
  await page.getByRole('button', { name: 'Rerun failed checks (3)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nothing to rerun' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('heading', { name: "Can't rerun (3)" }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Rerun \d/ })).toBeHidden();
  await dialog.getByRole('button', { name: 'Close' }).click();
  // Now the answers are in, the button says so without asking again.
  await expect(page.locator('#rerun-all-button')).toHaveText(
    'Rerun failed checks',
  );
  await expect(page.locator('.rerun-all')).toContainText(
    'None of the 3 failing pull requests can be rerun from here.',
  );
  expect(posts).toEqual([]);
});

// A forge that can't be asked: its rows are filed under Can't rerun with the
// reason, and neither the probe nor the rerun is sent.
const spent = {
  limit: 5000,
  remaining: 0,
  resetsAt: new Date(Date.now() + 20 * 60_000).toISOString(),
};
for (const [name, forge, reason] of [
  [
    'unreachable',
    { forge: 'github', reachable: false, repoCount: 1 },
    /reach/i,
  ],
  [
    'rate limited',
    { forge: 'github', reachable: true, repoCount: 1, rateLimitREST: spent },
    /rate limit reached/i,
  ],
] as const) {
  test(`a ${name} forge's rows go under Can't rerun with the reason, and nothing is sent`, async ({
    page,
  }) => {
    const { posts, probed } = await open(
      page,
      '/pull-requests.html',
      [pr(1), pr(2)],
      {},
      { forges: [forge] },
    );
    await page.locator('#rerun-all-button').click();
    const dialog = page.getByRole('dialog', { name: 'Nothing to rerun' });
    await expect(dialog).toBeVisible();
    const left = dialog.locator('#rerun-all-left-out-list > li');
    await expect(left).toHaveCount(2);
    await expect(left.first()).toContainText(reason);
    expect(probed).toEqual([]);
    expect(posts).toEqual([]);
  });
}

test("a Forgejo with no rerun route goes under Can't rerun with its reason, unasked", async ({
  page,
}) => {
  const reason = 'Rerunning checks needs Forgejo 17 or later.';
  const { probed } = await open(
    page,
    '/pull-requests.html',
    [pr(1), pr(2, { forge: 'forgejo', repo: 'home/app' })],
    {},
    {
      forges: [
        { forge: 'github', reachable: true, repoCount: 1 },
        {
          forge: 'forgejo',
          reachable: true,
          repoCount: 1,
          rerunChecksBlocked: reason,
        },
      ],
    },
  );
  await page.getByRole('button', { name: 'Rerun failed checks (1)' }).click();
  await expect(page.locator('#rerun-all-left-out-list > li')).toContainText(
    reason,
  );
  expect(probed).toEqual([1]);
});

test('a filter that hides a failing row takes it out of the count', async ({
  page,
}) => {
  await open(
    page,
    '/pull-requests.html',
    [pr(1), pr(2, { forge: 'forgejo', repo: 'home/app' })],
    {},
    {
      forges: [
        { forge: 'github', reachable: true, repoCount: 1 },
        { forge: 'forgejo', reachable: true, repoCount: 1 },
      ],
    },
  );
  await expect(
    page.getByRole('button', { name: 'Rerun failed checks (2)' }),
  ).toBeVisible();
  await page.locator('.quick-pill.forge-pill[data-pill="forgejo"]').click();
  await expect(
    page.getByRole('button', { name: 'Rerun failed checks (1)' }),
  ).toBeVisible();
});

for (const [scheme, width] of [
  ['light', 320],
  ['light', 390],
  ['dark', 390],
  ['light', 820],
  ['light', 1280],
  ['dark', 1280],
] as const) {
  test(`the control and dialog fit at ${width}px in ${scheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 800 });
    await open(page, '/pull-requests.html', [...mixed], mixedProbes);
    const button = page.getByRole('button', {
      name: 'Rerun failed checks (3)',
    });
    await expect(button).toBeVisible();
    const axe = async () =>
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
    const fits = () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      );
    await axe();
    expect(await fits()).toBe(true);
    if (width < 640) {
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    await button.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#rerun-all-plan')).toBeVisible();
    await expect(page.locator('#rerun-all-cancel')).toBeFocused();
    await axe();
    expect(await fits()).toBe(true);
    expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(
      true,
    );
    if (width < 640) {
      for (const id of ['rerun-all-cancel', 'rerun-all-confirm']) {
        const box = await page.locator(`#${id}`).boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#rerun-all-button')).toBeFocused();
  });
}

// The header is as tall with the button as without it, so a row turning red
// moves nothing below it (#3236). Phones are where the button used to wrap,
// and the Hidden toggle is what takes the room beside it.
for (const [name, path] of [
  ['Pull requests', '/pull-requests.html'],
  ['Bots', '/bots.html'],
] as const) {
  for (const hidden of [0, 2, 12]) {
    for (const width of [320, 390, 480, 481, 500, 523, 560, 820]) {
      test(`${name}: the header keeps its height when the button appears at ${width}px${hidden ? ` with the Hidden toggle (${hidden} hidden)` : ''}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        const author = name === 'Bots' ? 'dependabot[bot]' : 'ryankes';
        const rows = (ci: string) => [
          pr(1, { ci, author }),
          pr(2, { ci, author }),
        ];
        await open(page, path, rows('success'), {}, { hidden });
        await expect(page.locator('.row').first()).toBeVisible();
        await expect(page.locator('#rerun-all-button')).toBeHidden();
        if (hidden)
          await expect(page.locator('#hidden-prs-toggle')).toBeVisible();
        const head = page.locator('.board-head');
        const without = (await head.boundingBox())?.height;
        const rowTop = (await page.locator('.row').first().boundingBox())?.y;

        const withIt = await page.context().newPage();
        await withIt.setViewportSize({ width, height: 800 });
        await open(withIt, path, rows('failure'), {}, { hidden });
        const button = withIt.locator('#rerun-all-button');
        await expect(button).toBeVisible();
        expect(
          (await withIt.locator('.board-head').boundingBox())?.height,
        ).toBe(without);
        expect((await withIt.locator('.row').first().boundingBox())?.y).toBe(
          rowTop,
        );
        // The target never lands on the heading above it.
        const h2 = await withIt.locator('.board-head h2').boundingBox();
        const b = await button.boundingBox();
        if (width <= 560) expect(h2 && b && b.y >= h2.y + h2.height).toBe(true);
        await withIt.close();
      });
    }
  }
}

// A probe that failed is not remembered: the next press asks again, and the
// button count is right once the dialog is closed.
test('a failed probe is asked again on the next press', async ({ page }) => {
  const { probed } = await open(
    page,
    '/pull-requests.html',
    [pr(1)],
    { 1: { rerunnable: false, reason: 'no failed job to rerun' } },
    { probeFailures: 1 },
  );
  const button = page.locator('#rerun-all-button');
  await button.click();
  const dialog = page.getByRole('dialog');
  await expect(page.locator('#rerun-all-plan')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toHaveText('Rerun failed checks (1)');
  expect(probed).toEqual([1]);
  await button.click();
  await expect(
    page.getByRole('dialog', { name: 'Nothing to rerun' }),
  ).toBeVisible();
  expect(probed).toEqual([1, 1]);
});

// Closing the dialog while a probe is out: the button count is right at once,
// and a probe that then fails is not remembered.
test('closing the dialog mid-probe keeps the count right and retries a failed probe', async ({
  page,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { probed } = await open(
    page,
    '/pull-requests.html',
    [pr(1), pr(2)],
    { 1: { rerunnable: false, reason: 'no failed job to rerun' } },
    { hold: { 2: held }, failHeld: [2] },
  );
  const button = page.locator('#rerun-all-button');
  await expect(button).toHaveText('Rerun failed checks (2)');
  await button.click();
  await expect(page.locator('#rerun-all-checking')).toBeVisible();
  await expect.poll(() => probed).toEqual([1, 2]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  // Row 1 is answered and cannot run; row 2 is still out.
  await expect(button).toHaveText('Rerun failed checks (1)');
  release();
  await page.waitForTimeout(200);
  await button.click();
  await expect(page.locator('#rerun-all-plan')).toBeVisible();
  expect(probed).toEqual([1, 2, 2]);
});

// An answer that lands after the dialog closed still updates the count.
test('an answer that lands after the dialog closed updates the count', async ({
  page,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await open(
    page,
    '/pull-requests.html',
    [pr(1)],
    { 1: { rerunnable: false, reason: 'no failed job to rerun' } },
    { hold: { 1: held } },
  );
  const button = page.locator('#rerun-all-button');
  await button.click();
  await expect(page.locator('#rerun-all-checking')).toBeVisible();
  await page.keyboard.press('Escape');
  release();
  await expect(button).toHaveText('Rerun failed checks');
});

// With the Hidden toggle on a 320px row the label wraps instead of spilling
// over the toggle or past the edge.
test('the button wraps its label beside the Hidden toggle at 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await open(page, '/pull-requests.html', [pr(1), pr(2)], {}, { hidden: 2 });
  const button = page.locator('#rerun-all-button');
  await expect(button).toBeVisible();
  const toggle = page.locator('#hidden-prs-toggle');
  await expect(toggle).toBeVisible();
  const t = await toggle.boundingBox();
  const b = await button.boundingBox();
  expect(t && b && (t.x + t.width <= b.x || b.x + b.width <= t.x)).toBe(true);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  const lines = await button.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top)))
      .size;
  });
  expect(lines).toBeGreaterThan(1);
});
