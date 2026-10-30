import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import {
  offeredValues,
  pickButton,
  pickedValues,
  pickOnly,
  pickPanel,
  pickTexts,
  togglePicks,
} from './label-filter-helper';
import { test } from './server-fixture';

// The same login on two forges is two people, so the Author filter offers
// each once under its forge and a pick matches only that forge's pull
// requests.
// https://github.com/alrayyes/forge-dashboard/issues/2621

const NOW = new Date().toISOString();

function pr(number: number, forge: string, author: string, repo: string) {
  return {
    forge,
    repo,
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author,
    authorAvatarUrl: '',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: NOW,
    updatedAt: NOW,
    mergeStatus: 'mergeable',
  };
}

// 1 and 2 are two different people called sam; 3 is only on GitHub.
const PRS = [
  pr(1, 'github', 'sam', 'acme/api'),
  pr(2, 'forgejo', 'sam', 'acme/api'),
  pr(3, 'github', 'kim', 'acme/web'),
];

async function open(page: Page, prs = PRS) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: NOW,
        forges: [
          { forge: 'github', reachable: true, repoCount: 2 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests: prs,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row').first()).toBeVisible();
}

const rows = (page: Page) => page.locator('#pr-rows > .row');

test('one login on two forges is two author choices, under their forges', async ({
  page,
}) => {
  await open(page);
  expect(await offeredValues(page, 'author')).toEqual([
    'forgejo:sam',
    'github:kim',
    'github:sam',
  ]);
  expect(await pickTexts(page, 'author')).toEqual(['sam', 'kim', 'sam']);
  await pickButton(page, 'author').click();
  const panel = pickPanel(page, 'author');
  await expect(panel.getByRole('group', { name: 'Forgejo' })).toHaveCount(1);
  await expect(panel.getByRole('group', { name: 'GitHub' })).toHaveCount(1);
});

test('picking one sam lists only that forge, and the button names the forge', async ({
  page,
}) => {
  await open(page);
  await expect(rows(page)).toHaveCount(3);
  await togglePicks(page, 'author', 'forgejo:sam');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Pull request 2');
  await expect(pickButton(page, 'author')).toHaveText('sam (Forgejo)');

  await pickOnly(page, 'author', 'github:sam');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Pull request 1');
  expect(await pickedValues(page, 'author')).toEqual(['github:sam']);
});

test('the author panel has no accessibility violations with forge groups', async ({
  page,
}) => {
  await open(page);
  await pickButton(page, 'author').click();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

// An author pick saved by the release before this one is the bare login. It
// reads as every forge's choice with that whole login (any case) and is saved
// again in the new form.
test.describe('an author saved as a bare login by an earlier release', () => {
  const cookieShared = async (page: Page) => {
    const c = (await page.context().cookies()).find(
      (x) => x.name === 'forge-board-filters',
    );
    return c ? (JSON.parse(decodeURIComponent(c.value)).shared ?? {}) : {};
  };
  const serverShared = async (page: Page) =>
    (await (await page.request.get('/api/v1/settings/filter-state')).json())
      ?.shared ?? {};

  test('in the cookie is read as that login on each forge and saved qualified', async ({
    page,
    baseURL,
  }) => {
    await page.context().addCookies([
      {
        name: 'forge-board-filters',
        value: encodeURIComponent(
          JSON.stringify({
            shared: { author: 'Sam' },
            pr: {},
            issue: {},
            view: {},
          }),
        ),
        url: baseURL ?? '',
      },
    ]);
    await open(page);
    await expect(rows(page)).toHaveCount(2);
    expect(await pickedValues(page, 'author')).toEqual([
      'forgejo:sam',
      'github:sam',
    ]);
    await expect(page.locator('#held-picks .held-pick')).toHaveCount(0);
    await expect
      .poll(async () => (await cookieShared(page)).author)
      .toBe('forgejo:sam\ngithub:sam');
    await expect
      .poll(async () => (await serverShared(page)).author)
      .toBe('forgejo:sam\ngithub:sam');
  });

  test('in the server copy is read as that login on each forge and saved qualified', async ({
    page,
  }) => {
    await page.request.put('/api/v1/settings/filter-state', {
      data: { shared: { author: 'sam' }, pr: {}, issue: {}, view: {} },
    });
    await open(page);
    await expect(rows(page)).toHaveCount(2);
    expect(await pickedValues(page, 'author')).toEqual([
      'forgejo:sam',
      'github:sam',
    ]);
    await expect
      .poll(async () => (await serverShared(page)).author)
      .toBe('forgejo:sam\ngithub:sam');
    await expect
      .poll(async () => (await cookieShared(page)).author)
      .toBe('forgejo:sam\ngithub:sam');
  });

  test('on no forge here is set aside, named as having no forge and kept saved', async ({
    page,
  }) => {
    await page.request.put('/api/v1/settings/filter-state', {
      data: { shared: { author: 'ghost' }, pr: {}, issue: {}, view: {} },
    });
    await open(page);
    await expect(rows(page)).toHaveCount(3);
    await expect(
      page
        .locator('#held-picks')
        .getByText(
          'Saved author "ghost" has no forge and is not on this page.',
        ),
    ).toBeVisible();
    expect(await pickedValues(page, 'author')).toEqual([]);
    expect((await serverShared(page)).author).toBe('ghost');
  });

  // 19 other authors and a bare `sam` that is two choices come to 21, one past
  // the cap.
  const MANY = [
    ...Array.from({ length: 19 }, (_, i) =>
      pr(10 + i, 'github', `user${i}`, 'acme/api'),
    ),
    ...PRS,
  ];
  const picks = Array.from({ length: 19 }, (_, i) => `github:user${i}`);

  test('past the 20-value cap says how many choices were left out', async ({
    page,
  }) => {
    await page.request.put('/api/v1/settings/filter-state', {
      data: {
        shared: { author: [...picks, 'sam'].join('\n') },
        pr: {},
        issue: {},
        view: {},
      },
    });
    await open(page, MANY);
    await expect(page.locator('#feedback-toasts')).toContainText(
      'Your author filter expanded to more choices than fit, so 1 was left out.',
    );
    expect(await pickedValues(page, 'author')).toHaveLength(20);
    const results = await new AxeBuilder({ page })
      .include('#feedback-toasts')
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('within the cap says nothing', async ({ page }) => {
    await page.request.put('/api/v1/settings/filter-state', {
      data: { shared: { author: 'sam' }, pr: {}, issue: {}, view: {} },
    });
    await open(page, MANY);
    await expect.poll(async () => pickedValues(page, 'author')).toHaveLength(2);
    await expect(page.locator('#feedback-toasts')).not.toContainText(
      'more choices than fit',
    );
  });
});
