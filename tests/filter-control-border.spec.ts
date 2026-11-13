import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The edge of a filter text field or dropdown is the part of it that
// identifies it, so it needs 3:1 against what it sits on (WCAG 2.2 SC 1.4.11).
// The colour tokens are checked in web/src/lib/control-border-contrast.test.ts;
// this proves each page's controls really use them, in both themes.
// https://github.com/alrayyes/forge-dashboard/issues/3193

type Rgb = [number, number, number];

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The control's border colour and the first opaque background above it.
async function edge(control: Locator): Promise<{ border: Rgb; behind: Rgb }> {
  return control.evaluate((el) => {
    const parse = (value: string) => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      if (!m) throw new Error(`not a colour: ${value}`);
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).map(Number);
      return { rgb: [r, g, b] as Rgb, alpha: a };
    };
    let node: Element | null = el.parentElement;
    let behind: Rgb = [255, 255, 255];
    while (node) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg.alpha === 1) {
        behind = bg.rgb;
        break;
      }
      node = node.parentElement;
    }
    return {
      border: parse(getComputedStyle(el).borderTopColor).rgb,
      behind,
    };
  });
}

// The Webhooks and Branches pages draw their filters only once the server
// has repos or branches to list, so those two get one of each.
async function seed(page: Page, path: string) {
  // The Repositories button is hidden until the list holds two repositories.
  if (path === '/pull-requests.html') {
    const pr = (number: number, repo: string) => ({
      forge: 'github',
      repo,
      number,
      title: `Change ${number}`,
      url: `https://example.com/${number}`,
      author: 'ryan',
      draft: false,
      ci: 'success',
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mergeStatus: 'mergeable',
    });
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
    await page.route('**/api/v1/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
          pullRequests: [pr(1, 'acme/a'), pr(2, 'acme/b')],
          issues: [],
          repos: [],
          hiddenDrafts: 0,
          firstRefreshDone: true,
        }),
      }),
    );
    return;
  }
  if (path !== '/webhooks.html' && path !== '/') return;
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [],
        repos: [{ forge: 'github', fullName: 'acme/a', hasWebhook: true }],
        firstRefreshDone: true,
      }),
    }),
  );
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
            fullName: 'acme/a',
            url: 'https://example.com/acme/a',
            branch: 'main',
            status: 'passed',
            commit: {
              sha: 'd98f3c2',
              subject: 'fix: a change',
              author: 'dev',
              committedAt: new Date().toISOString(),
            },
            failingJobs: [],
            finishedAt: new Date().toISOString(),
            durationSeconds: 60,
            runUrl: 'https://example.com/acme/a/actions/runs/1',
            staleSince: null,
          },
        ],
      }),
    }),
  );
}

// One test per page per theme: the controls on a page share a load, so
// each is checked in turn after it.
const CONTROLS: Record<string, string[]> = {
  '/pull-requests.html': [
    'input.col-filter[data-col="title"]',
    'select.group-select',
    'button.label-filter-button.col-filter',
  ],
  '/issues.html': ['input.col-filter[data-col="title"]'],
  '/releases.html': ['input.col-filter[data-col="title"]'],
  '/bots.html': ['input.col-filter[data-col="title"]'],
  '/webhooks.html': ['input.col-filter', 'select.col-filter'],
  '/insights.html': ['input.col-filter'],
  '/': ['input.mb-search'],
};

for (const scheme of ['light', 'dark'] as const) {
  for (const [path, selectors] of Object.entries(CONTROLS)) {
    test(`the filter controls on ${path} have a 3:1 border in ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await seed(page, path);
      await page.goto(path);
      for (const selector of selectors) {
        const control = page.locator(selector).first();
        await expect(control, selector).toBeVisible();
        await expect
          .configure({ soft: true })
          .poll(
            async () => {
              const { border, behind } = await edge(control);
              return contrast(border, behind);
            },
            { message: selector },
          )
          .toBeGreaterThanOrEqual(3);
      }
    });
  }
}

test('a focused filter field still shows the 2px accent outline', async ({
  page,
}) => {
  await seed(page, '/pull-requests.html');
  await page.goto('/pull-requests.html');
  const title = page.locator('input.col-filter[data-col="title"]').first();
  await title.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(title).toBeFocused();
  await expect(title).toHaveCSS('outline-width', '2px');
  await expect(title).toHaveCSS('outline-style', 'solid');
});
