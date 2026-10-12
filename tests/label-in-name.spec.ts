import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

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
      // What the pills show must be in the name too, as numbers: an icon with
      // only pills (the header's) would otherwise pass unchecked.
      for (const pill of el.querySelectorAll('.nav-total, .nav-failed')) {
        const number = squash(pill.textContent ?? '');
        if (!new RegExp(`(^|\\D)${number}(\\D|$)`).test(name))
          found.push(`pill "${number}" is not in "${name}"`);
      }
      if (!visible) continue;
      if (!name.includes(visible))
        found.push(`"${visible}" is not in "${name}"`);
    }
    return found;
  });
}

test.describe('the check itself (#1315)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      `label-check-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'Label Check',
    );
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
      'pill "12" is not in "branches"',
      'pill "3" is not in "branches"',
    ]);
  });

  test('passes an icon link whose name says them', async ({ page }) => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<a href="#" aria-label="Branches, 12 total, 3 failing"><svg width="10" height="10"></svg><span class="nav-pills"><span class="nav-total">12</span><span class="nav-failed">3</span></span></a>',
      );
    });

    const added = (await mismatches(page)).filter((m) => m.includes('"12"'));
    expect(added).toEqual([]);
  });

  test('a longer number is not taken for a shorter one', async ({ page }) => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<a href="#" aria-label="Pull requests, 128 total"><span class="nav-pills"><span class="nav-total">12</span></span></a>',
      );
    });

    expect(await mismatches(page)).toEqual([
      'pill "12" is not in "pull requests, 128 total"',
    ]);
  });
});

test.describe('visible text is part of the accessible name (#1135)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      `label-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'Label Test User',
    );
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
