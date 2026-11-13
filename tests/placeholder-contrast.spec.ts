import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The hint text in the Issues "hide title regex" field and the Branches search
// box must read at 4.5:1 against the field in both themes. The unit test reads
// the stylesheet; this one reads what the browser painted.
// https://github.com/alrayyes/forge-dashboard/issues/3201

async function stub(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

async function placeholderContrast(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    type RGBA = [number, number, number, number];
    const parse = (s: string): RGBA => {
      const p = (s.match(/rgba?\(([^)]+)\)/)?.[1] ?? '0,0,0,0')
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    };
    const lum = ([r, g, b]: RGBA) => {
      const f = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    let backdrop: RGBA = [255, 255, 255, 1];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c[3] === 1) {
        backdrop = c;
        break;
      }
    }
    const fg = parse(getComputedStyle(el, '::placeholder').color);
    const [hi, lo] = [lum(fg), lum(backdrop)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Issues hide-title regex placeholder reads at 4.5:1 (${scheme}) (#3201)`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await stub(page);
    await page.goto('/issues.html');
    await expect(page.locator('#issue-hide-title-regex')).toBeVisible();
    await expect
      .poll(() => placeholderContrast(page, '#issue-hide-title-regex'))
      .toBeGreaterThanOrEqual(4.5);
  });

  test(`Branches search placeholder reads at 4.5:1 (${scheme}) (#3201)`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await stub(page);
    await page.route('**/api/v1/main-branches', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          counts: {
            failed: 0,
            passed: 1,
            running: 0,
            cancelled: 0,
            awaitingApproval: 0,
            none: 0,
            total: 1,
          },
          branches: [
            {
              forge: 'github',
              fullName: 'acme/auth-service',
              url: 'https://example.com/acme/auth-service',
              branch: 'main',
              status: 'passed',
              commit: {
                sha: 'd98f3c2',
                subject: 'fix: change',
                author: 'sre-dev',
                committedAt: new Date().toISOString(),
              },
              failingJobs: [],
              finishedAt: null,
              durationSeconds: null,
              runUrl: 'https://example.com/acme/auth-service/actions/runs/1',
              checks: { passed: 2, running: 0, waiting: 0, failed: 0 },
              staleSince: null,
            },
          ],
        }),
      }),
    );
    await page.goto('/');
    await expect(page.locator('input.mb-search')).toBeVisible();
    await expect
      .poll(() => placeholderContrast(page, 'input.mb-search'))
      .toBeGreaterThanOrEqual(4.5);
  });
}
