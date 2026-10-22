import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import {
  clearPicks,
  offeredValues,
  pickButton,
  pickedValues,
  pickOnly,
  pickPanel,
  pickTexts,
  togglePicks,
} from './label-filter-helper';
import { test } from './server-fixture';

// Repo and Author take several values at once and show what matches any of
// them, like Label. Each choice carries the repo's logo or the author's
// avatar, with an initial when there is none.
//
// Research the control and the decorative images are built on:
//   https://adrianroselli.com/2022/05/under-engineered-multi-selects.html
//   https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/
//   https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/
//   https://www.w3.org/WAI/tutorials/images/decorative/
// https://github.com/alrayyes/forge-dashboard/issues/2538

const NOW = new Date().toISOString();
const AVATAR = 'https://avatars.githubusercontent.com/u/1?v=4';
const LOGO = 'https://repository-images.githubusercontent.com/1/api-logo';
const BROKEN = 'https://avatars.githubusercontent.com/u/2?v=4';

const IMAGE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#2c7a4b"/></svg>',
);

function pr(
  number: number,
  author: string,
  repo: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    forge: 'github',
    repo,
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author,
    authorAvatarUrl:
      author === 'alice' ? AVATAR : author === 'bob' ? BROKEN : '',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: NOW,
    updatedAt: NOW,
    mergeStatus: 'mergeable',
    ...extra,
  };
}

// 1 alice api, 2 bob web, 3 carol web, 4 alice docs.
const PRS = [
  pr(1, 'alice', 'acme/api'),
  pr(2, 'bob', 'acme/web'),
  pr(3, 'carol', 'acme/web'),
  pr(4, 'alice', 'acme/docs'),
];

function issue(number: number, author: string, repo: string) {
  return {
    forge: 'github',
    repo,
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author,
    authorAvatarUrl: '',
    labels: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}
const ISSUES = [
  issue(1, 'alice', 'acme/api'),
  issue(2, 'bob', 'acme/web'),
  issue(3, 'carol', 'acme/docs'),
];

const repoEntry = (fullName: string, logoUrl?: string) => ({
  forge: 'github',
  fullName,
  url: `https://github.com/${fullName}`,
  ...(logoUrl ? { logoUrl } : {}),
  hasWebhook: false,
  canManageWebhooks: false,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
});

async function mock(
  page: Page,
  prs: Record<string, unknown>[] = PRS,
  forges = [{ forge: 'github', reachable: true, repoCount: 3 }],
) {
  await page.route(LOGO, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: IMAGE }),
  );
  await page.route(AVATAR, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: IMAGE }),
  );
  await page.route(BROKEN, (route: Route) => route.abort());
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: NOW,
        forges,
        pullRequests: prs,
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [
          repoEntry('acme/api', LOGO),
          repoEntry('acme/web'),
          repoEntry('acme/docs'),
        ],
        hiddenDrafts: 0,
      }),
    }),
  );
}

async function open(
  page: Page,
  url = '/pull-requests.html',
  prs: Record<string, unknown>[] = PRS,
) {
  await mock(page, prs);
  await page.goto(url);
  await expect(
    page.locator('#pr-rows, #issue-rows, .filter-bar').first(),
  ).toBeVisible();
}

const prRows = (page: Page) => page.locator('#pr-rows > .row');
const issueRows = (page: Page) => page.locator('#issue-rows > .row');

async function seedCookie(
  page: Page,
  baseURL: string | undefined,
  shared: Record<string, string>,
) {
  await page.context().addCookies([
    {
      name: 'forge-board-filters',
      value: encodeURIComponent(JSON.stringify({ shared })),
      url: baseURL ?? 'http://localhost:8080',
    },
  ]);
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe('Repo and Author: several values, matching any', () => {
  test('two repos list the pull requests in either, and the button counts them', async ({
    page,
  }) => {
    await open(page);
    await expect(prRows(page)).toHaveCount(4);
    await expect(pickButton(page, 'repo')).toHaveText('All repos');

    await togglePicks(page, 'repo', 'github:acme/api', 'github:acme/web');

    await expect(prRows(page)).toHaveCount(3);
    await expect(pickButton(page, 'repo')).toHaveText('2 repos');
    await expect(pickButton(page, 'repo')).toHaveAttribute(
      'aria-label',
      'Filter by repo: 2 repos',
    );
    expect(await pickedValues(page, 'repo')).toEqual([
      'github:acme/api',
      'github:acme/web',
    ]);
  });

  test('two authors list the pull requests by either, and one names itself', async ({
    page,
  }) => {
    await open(page);
    await togglePicks(page, 'author', 'alice');
    await expect(pickButton(page, 'author')).toHaveText('alice');
    await expect(prRows(page)).toHaveCount(2);

    await togglePicks(page, 'author', 'bob');
    await expect(pickButton(page, 'author')).toHaveText('2 authors');
    await expect(prRows(page)).toHaveCount(3);
  });

  test('a repo and an author together narrow each other', async ({ page }) => {
    await open(page);
    await togglePicks(page, 'author', 'alice');
    await expect(prRows(page)).toHaveCount(2);
    // Each control offers what the others leave: alice works in api and docs.
    expect(await offeredValues(page, 'repo')).toEqual([
      'github:acme/api',
      'github:acme/docs',
    ]);

    await togglePicks(page, 'repo', 'github:acme/api', 'github:acme/docs');
    await expect(prRows(page)).toHaveCount(2);
    await expect(pickButton(page, 'repo')).toHaveText('2 repos');
    expect(await offeredValues(page, 'author')).toEqual(['alice']);
  });

  test('Clear empties the list and shows everything again', async ({
    page,
  }) => {
    await open(page);
    await togglePicks(page, 'author', 'alice', 'bob');
    await expect(prRows(page)).toHaveCount(3);

    await clearPicks(page, 'author');

    await expect(prRows(page)).toHaveCount(4);
    await expect(pickButton(page, 'author')).toHaveText('All authors');
  });

  test('the Issues page filters by several repos and authors too', async ({
    page,
  }) => {
    await open(page, '/issues.html');
    await expect(issueRows(page)).toHaveCount(3);

    await togglePicks(page, 'repo', 'github:acme/api', 'github:acme/docs');
    await expect(issueRows(page)).toHaveCount(2);

    await clearPicks(page, 'repo');
    await togglePicks(page, 'author', 'bob', 'carol');
    await expect(issueRows(page)).toHaveCount(2);
    await expect(pickButton(page, 'author')).toHaveText('2 authors');
  });

  test('the Bots page has the same controls', async ({ page }) => {
    await open(page, '/bots.html');
    await expect(pickButton(page, 'repo')).toHaveText('All repos');
    await expect(pickButton(page, 'author')).toHaveText('All authors');
  });

  test('a pick made on one page is still two picks on the next', async ({
    page,
  }) => {
    await open(page);
    await togglePicks(page, 'repo', 'github:acme/api', 'github:acme/docs');
    await page
      .getByRole('link', { name: /^Issues/ })
      .first()
      .click();

    await expect(issueRows(page)).toHaveCount(2);
    await expect(pickButton(page, 'repo')).toHaveText('2 repos');
  });

  test('Insights shares the picks and the controls', async ({
    page,
    baseURL,
  }) => {
    await seedCookie(page, baseURL, {
      repo: 'github:acme/api\ngithub:acme/web',
      author: 'alice\nbob',
    });
    await open(page, '/insights.html');

    await expect(pickButton(page, 'repo')).toHaveText('2 repos');
    await expect(pickButton(page, 'author')).toHaveText('2 authors');
    expect(await pickedValues(page, 'repo')).toEqual([
      'github:acme/api',
      'github:acme/web',
    ]);
  });
});

test.describe('Repo and Author: saved picks', () => {
  test('a single value saved before there was a list reads back as a list of one', async ({
    page,
    baseURL,
  }) => {
    await seedCookie(page, baseURL, {
      repo: 'github:acme/api',
      author: 'alice',
    });
    await open(page);

    await expect(prRows(page)).toHaveCount(1);
    await expect(pickButton(page, 'repo')).toHaveText('acme/api');
    await expect(pickButton(page, 'author')).toHaveText('alice');
    expect(await pickedValues(page, 'repo')).toEqual(['github:acme/api']);

    await togglePicks(page, 'repo', 'github:acme/docs');
    await expect(pickButton(page, 'repo')).toHaveText('2 repos');
  });

  test('two picks survive a reload', async ({ page }) => {
    await open(page);
    await togglePicks(page, 'author', 'alice', 'bob');
    await expect(prRows(page)).toHaveCount(3);
    // Saving is debounced; wait for the saved copy before leaving.
    await expect
      .poll(async () => {
        const saved = await (
          await page.request.get('/api/settings/filter-state')
        ).json();
        return saved.shared?.author;
      })
      .toBe('alice\nbob');

    await page.reload();

    await expect(prRows(page)).toHaveCount(3);
    await expect(pickButton(page, 'author')).toHaveText('2 authors');
  });

  test('a saved repo this page does not offer is held, the others stay picked', async ({
    page,
    baseURL,
  }) => {
    await seedCookie(page, baseURL, {
      repo: 'github:acme/api\ngithub:gone/away',
    });
    await open(page);

    await expect(pickButton(page, 'repo')).toHaveText('acme/api');
    await expect(page.locator('#held-picks')).toContainText('gone/away');
    expect(await pickedValues(page, 'repo')).toEqual(['github:acme/api']);
  });
});

test.describe('Repo and Author: logos and avatars', () => {
  test('a repo shows its logo, an author their avatar, an initial otherwise', async ({
    page,
  }) => {
    await open(page);
    await pickButton(page, 'repo').click();
    const api = pickPanel(page, 'repo').locator('.label-filter-option', {
      hasText: 'acme/api',
    });
    await expect(api.locator('.pick-image img')).toHaveAttribute('src', LOGO);
    const web = pickPanel(page, 'repo').locator('.label-filter-option', {
      hasText: 'acme/web',
    });
    await expect(web.locator('.pick-image img')).toHaveCount(0);
    await expect(web.locator('.pick-initial')).toHaveText('W');
    await pickButton(page, 'repo').click();

    await pickButton(page, 'author').click();
    const alice = pickPanel(page, 'author').locator('.label-filter-option', {
      hasText: 'alice',
    });
    await expect(alice.locator('.pick-image img')).toHaveAttribute(
      'src',
      AVATAR,
    );
    const carol = pickPanel(page, 'author').locator('.label-filter-option', {
      hasText: 'carol',
    });
    await expect(carol.locator('.pick-image img')).toHaveCount(0);
    await expect(carol.locator('.pick-initial')).toHaveText('C');
  });

  test('an image that fails to load leaves the initial, and images are decorative', async ({
    page,
  }) => {
    await open(page);
    await pickButton(page, 'author').click();
    const bob = pickPanel(page, 'author').locator('.label-filter-option', {
      hasText: 'bob',
    });
    await expect(bob.locator('.pick-image img')).toHaveCount(0);
    await expect(bob.locator('.pick-initial')).toHaveText('B');
    await expect(bob.locator('.pick-image')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    const alt = await pickPanel(page, 'author')
      .locator('.pick-image img')
      .evaluateAll((imgs) =>
        imgs.map((i) => ({
          alt: (i as HTMLImageElement).alt,
          referrer: (i as HTMLImageElement).referrerPolicy,
        })),
      );
    expect(alt.length).toBeGreaterThan(0);
    for (const entry of alt)
      expect(entry).toEqual({ alt: '', referrer: 'no-referrer' });
  });

  test('a plain http avatar is not loaded', async ({ page }) => {
    const prs = [
      pr(1, 'dave', 'acme/api', {
        authorAvatarUrl: 'http://avatars.example.com/dave.png',
      }),
    ];
    await open(page, '/pull-requests.html', prs);
    await pickButton(page, 'author').click();
    const dave = pickPanel(page, 'author').locator('.label-filter-option');
    await expect(dave.locator('.pick-image img')).toHaveCount(0);
    await expect(dave.locator('.pick-initial')).toHaveText('D');
  });

  test('a ticked value is a chip with its image and its own remove button', async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedCookie(page, baseURL, {
      repo: 'github:acme/api',
      author: 'alice',
    });
    await open(page);

    const chips = page.locator('#active-filters .filter-chip');
    await expect(chips).toHaveCount(2);
    await expect(
      chips.filter({ hasText: 'acme/api' }).locator('.pick-image img'),
    ).toHaveAttribute('src', LOGO);
    await expect(
      chips.filter({ hasText: 'alice' }).locator('.pick-image img'),
    ).toHaveAttribute('src', AVATAR);

    await page
      .getByRole('button', { name: 'Remove filter: Author alice' })
      .click();
    await expect(chips).toHaveCount(1);
    await expect(prRows(page)).toHaveCount(1);
    await expect(pickButton(page, 'author')).toHaveText('All authors');
  });
});

test.describe('Repo and Author: forges, limits and accessibility', () => {
  test('a repo name on two forges is listed under a heading per forge', async ({
    page,
  }) => {
    const prs = [
      pr(1, 'alice', 'acme/api'),
      pr(2, 'bob', 'acme/api', { forge: 'forgejo' }),
    ];
    await mock(page, prs, [
      { forge: 'github', reachable: true, repoCount: 1 },
      { forge: 'forgejo', reachable: true, repoCount: 1 },
    ]);
    await page.goto('/pull-requests.html');
    await expect(prRows(page)).toHaveCount(2);

    await pickButton(page, 'repo').click();
    await expect(
      pickPanel(page, 'repo').locator('.pick-group-heading'),
    ).toHaveText(['Forgejo', 'GitHub']);
    await pickButton(page, 'repo').click();

    await togglePicks(page, 'repo', 'forgejo:acme/api', 'github:acme/api');
    await expect(prRows(page)).toHaveCount(2);
    await expect(pickButton(page, 'repo')).toHaveText('2 repos');
  });

  test('stops at twenty authors: the other boxes are disabled', async ({
    page,
  }) => {
    const prs = Array.from({ length: 22 }, (_, i) =>
      pr(i + 1, `user${String(i).padStart(2, '0')}`, 'acme/api'),
    );
    await open(page, '/pull-requests.html', prs);
    await pickButton(page, 'author').click();
    for (let i = 0; i < 20; i++)
      await pickPanel(page, 'author')
        .getByRole('checkbox', { name: `user${String(i).padStart(2, '0')}` })
        .check();

    await expect(pickButton(page, 'author')).toHaveText('20 authors');
    await expect(
      pickPanel(page, 'author').getByRole('checkbox', { name: 'user20' }),
    ).toBeDisabled();
    await expect(pickPanel(page, 'author')).toContainText('Up to 20');
  });

  test('opens with Enter, ticks with Space and closes with Escape', async ({
    page,
  }) => {
    await open(page);
    await pickButton(page, 'author').focus();
    await page.keyboard.press('Enter');
    await expect(pickButton(page, 'author')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(pickButton(page, 'author')).toContainText('alice');
    await page.keyboard.press('Escape');
    await expect(pickButton(page, 'author')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(pickButton(page, 'author')).toBeFocused();
  });

  test('names the choices as plain text beside their images', async ({
    page,
  }) => {
    await open(page);
    expect(await pickTexts(page, 'author')).toEqual(['alice', 'bob', 'carol']);
    expect(await pickTexts(page, 'repo')).toEqual([
      'acme/api',
      'acme/docs',
      'acme/web',
    ]);
  });

  test('has no axe violations open with picks and images, light and dark', async ({
    page,
  }) => {
    await open(page);
    await pickButton(page, 'repo').click();
    await pickPanel(page, 'repo')
      .getByRole('checkbox', { name: 'acme/api' })
      .check();
    await pickPanel(page, 'repo')
      .getByRole('checkbox', { name: 'acme/web' })
      .check();
    await axe(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await axe(page);
    await pickOnly(page, 'repo', '');
  });

  test('on a phone it lives in the Filters sheet with chips and no axe violations', async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedCookie(page, baseURL, {
      repo: 'github:acme/api\ngithub:acme/docs',
    });
    await open(page);

    await expect(page.locator('#active-filters .filter-chip')).toHaveCount(2);
    await page.getByRole('button', { name: /^Filters/ }).click();
    await pickButton(page, 'author').click();
    await pickPanel(page, 'author')
      .getByRole('checkbox', { name: 'alice' })
      .check();
    await expect(page.locator('#active-filters .filter-chip')).toHaveCount(3);
    const box = await pickPanel(page, 'author')
      .getByRole('checkbox', { name: 'alice' })
      .locator('xpath=ancestor::label')
      .boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await axe(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await axe(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    // The chip strip scrolls inside itself; the page does not grow.
    expect(overflow).toBe(false);
  });
});
