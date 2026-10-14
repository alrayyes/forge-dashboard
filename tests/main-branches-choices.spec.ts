import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1427: the Branches page offers a status or forge pill only when clicking
// it would show something, and keeps the one that is active so it can be
// cleared. The counts on the pills stay what they were.
// https://github.com/alrayyes/forge-dashboard/issues/1427

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `branch-choices-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Branch Choices');
}

const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60_000).toISOString();

type Status = 'failed' | 'running' | 'passed' | 'none';

function row(fullName: string, status: Status, forge = 'github') {
  return {
    forge,
    fullName,
    url: `https://example.com/${fullName}`,
    branch: 'main',
    status,
    commit:
      status === 'none'
        ? null
        : {
            sha: 'd98f3c2',
            subject: `fix: change in ${fullName}`,
            author: 'sre-dev',
            committedAt: minutesAgo(30),
          },
    failingJobs: status === 'failed' ? ['lint'] : [],
    finishedAt:
      status === 'running' || status === 'none' ? null : minutesAgo(12),
    durationSeconds: status === 'running' || status === 'none' ? null : 252,
    runUrl: `https://example.com/${fullName}/actions/runs/1`,
    stale: false,
    staleSince: null,
  };
}

function snapshot(branches: ReturnType<typeof row>[]) {
  const count = (s: string) => branches.filter((b) => b.status === s).length;
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      failed: count('failed'),
      passed: count('passed'),
      running: count('running'),
      none: count('none'),
      total: branches.length,
    },
    branches,
  };
}

let current: ReturnType<typeof snapshot>;

async function open(branches: ReturnType<typeof row>[]) {
  current = snapshot(branches);
}

async function serve(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(current),
    }),
  );
}

const pill = (page: Page, name: RegExp) =>
  page.locator('.mb-bar').getByRole('button', { name });

const MIXED = [
  row('acme/ingress', 'failed'),
  row('infra/homelab', 'failed', 'forgejo'),
  row('acme/builder', 'running'),
  row('acme/auth', 'passed'),
  row('acme/billing', 'passed'),
  row('infra/wiki', 'none', 'forgejo'),
];

test.describe('Branches pills offer only what would show something (#1427)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('a status and a forge nothing is in are not offered', async ({
    page,
  }) => {
    await open([row('acme/auth', 'passed'), row('acme/billing', 'passed')]);
    await serve(page);
    await page.goto('/');
    await expect(page.getByTestId('main-branch-row')).toHaveCount(2);

    for (const name of [/^All \d+$/, /^Passing/, /^All forges/, /^GitHub/]) {
      await expect(pill(page, name)).toBeVisible();
    }
    for (const name of [/^Failing/, /^Running/, /^No pipeline/, /^Forgejo/]) {
      await expect(pill(page, name)).toBeHidden();
    }
  });

  test('everything is offered when everything is there', async ({ page }) => {
    await open(MIXED);
    await serve(page);
    await page.goto('/');
    await expect(page.getByTestId('main-branch-row')).toHaveCount(6);

    for (const name of [
      /^Failing/,
      /^Passing/,
      /^Running/,
      /^No pipeline/,
      /^GitHub/,
      /^Forgejo/,
    ]) {
      await expect(pill(page, name)).toBeVisible();
    }
  });

  test('the status pills follow the forge pill and the search', async ({
    page,
  }) => {
    await open(MIXED);
    await serve(page);
    await page.goto('/');
    await expect(page.getByTestId('main-branch-row')).toHaveCount(6);

    await pill(page, /^Forgejo/).click();
    // Forgejo has a failing branch and one with no pipeline, nothing else.
    await expect(pill(page, /^Failing/)).toBeVisible();
    await expect(pill(page, /^No pipeline/)).toBeVisible();
    await expect(pill(page, /^Running/)).toBeHidden();
    await expect(pill(page, /^Passing/)).toBeHidden();

    await pill(page, /^All forges/).click();
    await page.getByRole('searchbox').fill('billing');
    await expect(pill(page, /^Passing/)).toBeVisible();
    await expect(pill(page, /^Failing/)).toBeHidden();
    await expect(pill(page, /^Forgejo/)).toBeHidden();
  });

  test('the forge pills follow the status pill', async ({ page }) => {
    await open(MIXED);
    await serve(page);
    await page.goto('/');
    await expect(page.getByTestId('main-branch-row')).toHaveCount(6);
    await expect(pill(page, /^Forgejo/)).toBeVisible();

    await pill(page, /^Passing/).click();

    // Both passing branches are on GitHub, so Forgejo would show nothing.
    await expect(page.getByTestId('main-branch-row')).toHaveCount(2);
    await expect(pill(page, /^Forgejo/)).toBeHidden();
    await expect(pill(page, /^GitHub/)).toBeVisible();

    await pill(page, /^Failing/).click();
    // One failing branch on each forge.
    await expect(pill(page, /^Forgejo/)).toBeVisible();
    await expect(pill(page, /^GitHub/)).toBeVisible();
  });

  test('the active pill stays offered after a reload that finds nothing for it', async ({
    page,
  }) => {
    await open(MIXED);
    await serve(page);
    await page.goto('/');
    await pill(page, /^Failing/).click();
    await expect(page.getByTestId('main-branch-row')).toHaveCount(2);

    await open([row('acme/auth', 'passed')]);
    await page.reload();

    await expect(pill(page, /^Failing/)).toBeVisible();
    await expect(pill(page, /^Failing/)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('no-match')).toBeVisible();
    await expect(pill(page, /^Running/)).toBeHidden();
  });

  test('has no axe-core violations with pills hidden', async ({ page }) => {
    await open([row('acme/auth', 'passed')]);
    await serve(page);
    await page.goto('/');
    await expect(page.getByTestId('main-branch-row')).toHaveCount(1);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
