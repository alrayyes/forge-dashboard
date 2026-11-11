import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// "Rerun failed checks" on the Pull requests and Bots pages (#3236). Who may
// rerun and the wording are pinned in rerun-all.test.ts; these cases pin the
// wiring: the header strip, the two groups of the dialog, the requests made
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
    test('the button counts the rows a rerun can restart', async ({ page }) => {
      await open(page, path, [...rows], mixedProbes);
      await expect(
        page.getByRole('button', { name: 'Rerun failed checks (2)' }),
      ).toBeVisible();
    });

    test('the dialog sorts the rows, and confirming asks only the first group', async ({
      page,
    }) => {
      const { posts } = await open(page, path, [...rows], mixedProbes, {
        refuse: { 4: 'The run is too old to rerun.' },
      });
      await page
        .getByRole('button', { name: 'Rerun failed checks (2)' })
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
      await expect(page.locator('#rerun-all-result')).toContainText(
        'acme/app #4: The run is too old to rerun.',
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

test('when no failing row can run the button is off and says why', async ({
  page,
}) => {
  const none = { rerunnable: false, reason: 'no failed GitHub Actions job x' };
  const { posts } = await open(
    page,
    '/pull-requests.html',
    [pr(1), pr(2), pr(3)],
    { 1: none, 2: none, 3: none },
  );
  const button = page.locator('#rerun-all-button');
  await expect(button).toHaveText('Rerun failed checks');
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.rerun-all')).toContainText(
    'None of the 3 failing pull requests can be rerun from here.',
  );
  await button.click({ force: true });
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(posts).toEqual([]);
});

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
    [pr(1), pr(2, { repo: 'acme/other' })],
    {},
  );
  await expect(
    page.getByRole('button', { name: 'Rerun failed checks (2)' }),
  ).toBeVisible();
  await page.goto('/pull-requests.html?q=other');
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
  test(`the strip and dialog fit at ${width}px in ${scheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 800 });
    await open(page, '/pull-requests.html', [...mixed], mixedProbes);
    const button = page.getByRole('button', {
      name: 'Rerun failed checks (2)',
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
    await expect(button).toBeFocused();
  });
}
