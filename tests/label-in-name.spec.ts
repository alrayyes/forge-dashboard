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
      const visible = squash(el.innerText).toLowerCase();
      if (!visible) continue;
      const name = squash(el.getAttribute('aria-label') ?? '').toLowerCase();
      if (!name.includes(visible))
        found.push(`"${visible}" is not in "${name}"`);
    }
    return found;
  });
}

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
        }),
      }),
    );
  });

  for (const path of ['/', '/issues.html']) {
    test(`${path} has no label that leaves out its visible text`, async ({
      page,
    }) => {
      await page.goto(path);
      await expect(page.locator('.bottom-nav .nav-badge')).toBeVisible();
      expect(await mismatches(page)).toEqual([]);
    });
  }
});
