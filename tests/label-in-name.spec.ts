import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// #1135: WCAG 2.5.3 (Label in Name). Someone who drives the page by voice
// says the words they see, so an aria-label has to contain them. Lighthouse
// flags the same thing as label-content-name-mismatch.
const now = new Date().toISOString();
const issue = (number: number) => ({
  forge: 'github',
  repo: 'alrayyes/app',
  number,
  title: `Issue ${number}`,
  url: `https://example.com/${number}`,
  author: 'ryan',
  labels: [],
  createdAt: now,
  updatedAt: now,
});

async function mismatches(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
    const found: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      'a[aria-label], button[aria-label]',
    )) {
      if (!el.checkVisibility()) continue;
      // The nav's count pills are state, not label (#1315): the name carries
      // their numbers in words ("27 PRs, 5 failing"), so the label to find
      // in the name is what is left without them.
      const bare = el.cloneNode(true) as HTMLElement;
      for (const pills of bare.querySelectorAll('.nav-pills')) pills.remove();
      const visible = squash(bare.textContent ?? '').toLowerCase();
      const name = squash(el.getAttribute('aria-label') ?? '').toLowerCase();
      // What the pills show must be in the name too, each next to its own
      // word: "12 total" ("12 Branches" on a tab, which shows its numbers
      // first) and "3 failing". An icon with only pills (the header's) would
      // otherwise pass unchecked, and swapped numbers would pass a looser rule.
      const total = el.querySelector('.nav-total');
      if (total) {
        const n = squash(total.textContent ?? '');
        if (!new RegExp(`(^${n} |, ${n} total)`).test(name))
          found.push(`total "${n}" is not in "${name}"`);
      }
      const failed = el.querySelector('.nav-failed');
      if (failed) {
        const n = squash(failed.textContent ?? '');
        if (!new RegExp(`(^|, )${n} failing`).test(name))
          found.push(`failed "${n}" is not in "${name}"`);
      }
      // Running and passed counts (#1439), each next to its own word.
      for (const [selector, word] of [
        ['.nav-running', 'running'],
        ['.nav-passed', 'passing'],
      ] as const) {
        const count = el.querySelector(selector);
        if (!count) continue;
        const n = squash(count.textContent ?? '');
        if (!new RegExp(`(^|, )${n} ${word}`).test(name))
          found.push(`${word} "${n}" is not in "${name}"`);
      }
      if (!visible) continue;
      if (!name.includes(visible))
        found.push(`"${visible}" is not in "${name}"`);
    }
    return found;
  });
}

test.describe('the check itself (#1315)', () => {
  // Writes nothing per user, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  // Signing in used to land on the pull request list, which these tests
  // inject their markup into.
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
    await page.goto('/pull-requests.html');
  });

  // An icon-only header link has nothing but pills on screen, so the check
  // must still read them against the name.
  test('flags an icon link whose name leaves out its numbers', async ({
    page,
  }) => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<a href="#" aria-label="Branches"><svg width="10" height="10"></svg><span class="nav-pills"><span class="nav-total">12</span><span class="nav-failed">3</span></span></a>',
      );
    });

    expect(await mismatches(page)).toEqual([
      'total "12" is not in "branches"',
      'failed "3" is not in "branches"',
    ]);
  });

  test('passes an icon link whose name says them', async ({ page }) => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<a href="#" aria-label="Branches, 12 total, 3 failing"><svg width="10" height="10"></svg><span class="nav-pills"><span class="nav-total">12</span><span class="nav-failed">3</span></span></a>',
      );
    });

    expect(await mismatches(page)).toEqual([]);
  });

  test('a longer number is not taken for a shorter one', async ({ page }) => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<a href="#" aria-label="Pull requests, 128 total"><span class="nav-pills"><span class="nav-total">12</span></span></a>',
      );
    });

    expect(await mismatches(page)).toEqual([
      'total "12" is not in "pull requests, 128 total"',
    ]);
  });

  test('a running or passing count missing from the name is caught (#1439)', async ({
    page,
  }) => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<a href="#" aria-label="Pull requests, 15 total, 2 failing"><span class="nav-pills"><span class="nav-total">15</span><span class="nav-count nav-failed">2</span><span class="nav-count nav-running">3</span><span class="nav-count nav-passed">10</span></span></a>',
      );
    });

    expect(await mismatches(page)).toEqual([
      'running "3" is not in "pull requests, 15 total, 2 failing"',
      'passing "10" is not in "pull requests, 15 total, 2 failing"',
    ]);
  });

  test('swapped numbers are caught', async ({ page }) => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<a href="#" aria-label="Branches, 3 total, 12 failing"><span class="nav-pills"><span class="nav-total">12</span><span class="nav-failed">3</span></span></a>',
      );
    });

    expect(await mismatches(page)).toEqual([
      'total "12" is not in "branches, 3 total, 12 failing"',
      'failed "3" is not in "branches, 3 total, 12 failing"',
    ]);
  });
});

test.describe('visible text is part of the accessible name (#1135)', () => {
  // Reads only, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/dashboard/stream', (route) =>
      route.fulfill({ status: 404, body: '{}' }),
    );
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: now,
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [
            {
              forge: 'github',
              repo: 'alrayyes/app',
              number: 1,
              title: 'A pull request',
              url: 'https://example.com/1',
              author: 'ryan',
              draft: false,
              ci: 'failure',
              mergeStatus: 'mergeable',
              labels: [],
              createdAt: now,
              updatedAt: now,
            },
          ],
          issues: [issue(2), issue(3)],
          openIssueCount: 2,
          navCounts: {
            branches: { total: 0, failed: 0 },
            pullRequests: { total: 1, failed: 1 },
            issues: { total: 2 },
            releases: { total: 0, failed: 0 },
            bots: { total: 0, failed: 0 },
          },
        }),
      }),
    );
  });

  for (const path of ['/pull-requests.html', '/issues.html']) {
    test(`${path} has no label that leaves out its visible text`, async ({
      page,
    }) => {
      await page.goto(path);
      await expect(
        page.locator('.bottom-nav a[href="/issues.html"] .nav-total'),
      ).toBeVisible();
      expect(await mismatches(page)).toEqual([]);
    });
  }
});
