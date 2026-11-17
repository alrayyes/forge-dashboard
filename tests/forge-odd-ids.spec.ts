import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { rateLimit } from './rate-limit-mock';
import { test } from './server-fixture';

// A forge id comes from the server. One named like an inherited object key
// (`constructor`, `__proto__`) is a forge nobody described: its badge names
// the id, carries no colour class, and no page renders a function's source.
// https://github.com/alrayyes/forge-dashboard/issues/4179

const IDS = ['constructor', '__proto__'];
// Rows sort by repo name, and the webhooks badge has a leading space.
const IDS_ANY_ORDER = [
  /^\s*(__proto__|constructor)$/,
  /^\s*(__proto__|constructor)$/,
];

// Capabilities with no label, so the page has nothing to name the forge by.
const unlabelled = (forge: string, over: Record<string, unknown> = {}) =>
  forgeHealth('github', {
    forge,
    capabilities: {
      ...forgeHealth('github').capabilities,
      label: '',
      advisorySource: 'dependabot',
    },
    ...over,
  });

const inMinutes = (m: number) =>
  new Date(Date.now() + m * 60_000).toISOString();

function pr(number: number, forge: string) {
  return {
    forge,
    repo: `lab/${number}`,
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    allowedActions: [],
    status: null,
    kind: 'regular',
  };
}

async function mockDashboard(page: Page, body: Record<string, unknown>) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: IDS.map((id) =>
          unlabelled(id, { rateLimitREST: rateLimit(5000, 10, inMinutes(30)) }),
        ),
        pullRequests: [],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
        ...body,
      }),
    }),
  );
}

test.describe('a forge named like an inherited key (#4179)', () => {
  test('the overview badges and the budget text name the id', async ({
    page,
  }) => {
    await mockDashboard(page, {
      pullRequests: IDS.map((id, i) => pr(i + 1, id)),
    });
    await page.goto('/pull-requests.html');

    const badges = page.locator('.forge-badge');
    await expect(badges).toHaveCount(2);
    await expect(badges).toHaveText(IDS_ANY_ORDER);
    for (const badge of await badges.all())
      await expect(badge).toHaveAttribute('class', /^forge-badge\s*$/);

    const budgets = page.locator('#forge-health .forge-health-budget');
    await expect(budgets).toHaveCount(2);
    await expect(budgets).toContainText([
      /^(constructor|__proto__) REST: /,
      /^(constructor|__proto__) REST: /,
    ]);
    await expect(page.locator('#forge-health')).not.toContainText(
      /function|\[object/i,
    );
  });

  test('the webhooks table badges the id with no colour class', async ({
    page,
  }) => {
    await mockDashboard(page, {
      repos: IDS.map((id) => ({
        forge: id,
        fullName: `lab/${id}`,
        hasWebhook: true,
      })),
    });
    await page.goto('/webhooks.html');

    const badges = page.locator('#webhooks-rows .forge-badge');
    await expect(badges).toHaveText(IDS_ANY_ORDER);
    for (const badge of await badges.all())
      await expect(badge).toHaveAttribute('class', /^forge-badge\s*$/);
  });

  test('the Branches page names the id, and an unknown reason shows the unknown wording', async ({
    page,
  }) => {
    const branch = (forge: string) => ({
      forge,
      fullName: `lab/${forge}`,
      url: `https://example.com/lab/${forge}`,
      branch: 'main',
      status: 'passed',
      commit: {
        sha: 'd98f3c2',
        subject: 'fix: change',
        author: 'sre-dev',
        committedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
      failingJobs: [],
      finishedAt: null,
      durationSeconds: null,
      runUrl: `https://example.com/lab/${forge}/actions/runs/1`,
      checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
      latestRelease: null,
      staleSince: null,
      advisories: { state: 'unknown', count: 0, reason: 'constructor' },
    });
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
    await page.route('**/api/v1/main-branches', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: IDS.map((id) => unlabelled(id)),
          counts: {
            failed: 0,
            passed: 2,
            running: 0,
            cancelled: 0,
            awaitingApproval: 0,
            none: 0,
            total: 2,
          },
          branches: IDS.map(branch),
        }),
      }),
    );
    await page.goto('/');

    const rows = page.locator('[data-testid="main-branch-row"]');
    await expect(rows).toHaveCount(2);
    await expect(page.locator('.forge-badge')).toHaveText(IDS_ANY_ORDER);
    for (const badge of await page.locator('.forge-badge').all())
      await expect(badge).toHaveAttribute('class', /^forge-badge\s*$/);
    await expect(page.locator('.mb-pill[aria-pressed]')).toContainText([
      'constructor',
      '__proto__',
    ]);
    const notices = page.getByTestId('advisories-notice');
    await expect(notices).toHaveCount(2);
    for (const notice of await notices.all())
      await expect(notice).not.toContainText(/function|\[object/i);
  });
});
