#!/usr/bin/env node
// Regenerates docs/screenshots/<page>-{light,dark}.png for every page in the
// menu (branches, pull requests, issues, releases, bots, insights, webhooks,
// settings, admin) and the login page (the footer pages are left out) against a real
// build of the binary, run by the release workflow's screenshots job —
// not a Playwright *test* (playwright.config.js only looks in tests/),
// so the main e2e suite never picks this up.
//
// Every page's /api/dashboard fetch is mocked with fixture data,
// the same way tests/dashboard.spec.ts's own route mocks work: this runs
// in CI with no live GitHub/Forgejo credentials, and a screenshot only
// needs to look like the real product, not show a real account's actual
// open pull requests — the same reason the registered display name,
// username, and every repo except this project's own are fictional
// rather than Ryan's real name or infrastructure (#250).

import path from 'node:path';
import { chromium } from '@playwright/test';
import { addVirtualAuthenticator } from '../tests/webauthn-helper';

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');

function daysAgo(n: number) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

const SNAPSHOT = {
  generatedAt: new Date().toISOString(),
  forges: [
    { forge: 'github', reachable: true, repoCount: 4 },
    { forge: 'forgejo', reachable: true, repoCount: 2 },
  ],
  pullRequests: [
    {
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 142,
      title: 'feat: keep repo and author filters scoped to the active forge',
      url: 'https://github.com/alrayyes/forge-dashboard/pull/142',
      author: 'demo-user',
      ci: 'success',
      labels: [{ name: 'enhancement', color: 'a2eeef' }],
      createdAt: daysAgo(0.2),
      updatedAt: daysAgo(0.05),
    },
    {
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 139,
      title: 'fix: SQLITE_BUSY under concurrent writers',
      url: 'https://github.com/alrayyes/forge-dashboard/pull/139',
      author: 'demo-user',
      ci: 'failure',
      labels: [{ name: 'bug', color: 'd73a4a' }],
      createdAt: daysAgo(2),
      updatedAt: daysAgo(0.3),
    },
    {
      forge: 'forgejo',
      repo: 'sandbox/vps-docker',
      number: 58,
      title: 'chore: bump traefik to v3.2',
      url: 'https://git.example.com/sandbox/vps-docker/pulls/58',
      author: 'claude',
      ci: 'pending',
      labels: [],
      createdAt: daysAgo(0.1),
      updatedAt: daysAgo(0.02),
    },
    {
      forge: 'github',
      repo: 'example-org/wiki',
      number: 24,
      title: 'docs: add architecture diagram',
      url: 'https://github.com/example-org/wiki/pull/24',
      author: 'demo-user',
      ci: 'success',
      labels: [{ name: 'documentation', color: '0075ca' }],
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
    },
    {
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 143,
      title: 'chore(main): release 0.9.0',
      url: 'https://github.com/alrayyes/forge-dashboard/pull/143',
      author: 'release-please[bot]',
      ci: 'success',
      kind: 'release',
      labels: [{ name: 'autorelease: pending', color: 'ededed' }],
      createdAt: daysAgo(0.5),
      updatedAt: daysAgo(0.2),
    },
    {
      forge: 'forgejo',
      repo: 'sandbox/vps-docker',
      number: 60,
      title: 'chore(main): release 1.4.2',
      url: 'https://git.example.com/sandbox/vps-docker/pulls/60',
      author: 'release-please[bot]',
      ci: 'pending',
      kind: 'release',
      labels: [],
      createdAt: daysAgo(0.3),
      updatedAt: daysAgo(0.1),
    },
    {
      forge: 'github',
      repo: 'example-org/api-gateway',
      number: 88,
      title: 'chore(deps): update dependency vite to v8.1.0',
      url: 'https://github.com/example-org/api-gateway/pull/88',
      author: 'renovate[bot]',
      ci: 'success',
      kind: 'dependency',
      labels: [{ name: 'dependencies', color: '0366d6' }],
      createdAt: daysAgo(1.2),
      updatedAt: daysAgo(1.2),
    },
    {
      forge: 'github',
      repo: 'example-org/docs-site',
      number: 41,
      title: 'Bump astro from 5.2.0 to 5.3.1',
      url: 'https://github.com/example-org/docs-site/pull/41',
      author: 'dependabot[bot]',
      ci: 'failure',
      kind: 'dependency',
      labels: [{ name: 'dependencies', color: '0366d6' }],
      createdAt: daysAgo(2.4),
      updatedAt: daysAgo(2.4),
    },
  ],
  openIssueCount: 3,
  issues: [
    {
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 145,
      title: 'Add a GitLab forge alongside GitHub and Forgejo',
      url: 'https://github.com/alrayyes/forge-dashboard/issues/145',
      author: 'demo-user',
      labels: [{ name: 'enhancement', color: 'a2eeef' }],
      createdAt: daysAgo(3),
      updatedAt: daysAgo(3),
    },
    {
      forge: 'forgejo',
      repo: 'sandbox/vps-docker',
      number: 52,
      title: 'Traefik dashboard occasionally 502s right after a redeploy',
      url: 'https://git.example.com/sandbox/vps-docker/issues/52',
      author: 'claude',
      labels: [{ name: 'bug', color: 'd73a4a' }],
      createdAt: daysAgo(4),
      updatedAt: daysAgo(1.5),
    },
    {
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 131,
      title: 'Support saved filter presets, not just cookie persistence',
      url: 'https://github.com/alrayyes/forge-dashboard/issues/131',
      author: 'demo-user',
      labels: [{ name: 'documentation', color: '0075ca' }],
      createdAt: daysAgo(10),
      updatedAt: daysAgo(6),
    },
  ],
};

// The Branches page reads its own endpoint, GET /api/main-branches.
function mainBranch(
  forge: 'github' | 'forgejo',
  fullName: string,
  status: 'failed' | 'running' | 'passed' | 'none',
  branch = 'main',
) {
  const noCommit = status === 'none';
  const minutes = (n: number) =>
    new Date(Date.now() - n * 60_000).toISOString();
  return {
    forge,
    fullName,
    url: `https://example.com/${fullName}`,
    branch,
    status,
    commit: noCommit
      ? null
      : {
          sha: 'd98f3c2',
          subject: `fix: handle an empty response in ${fullName.split('/')[1]}`,
          author: 'demo-user',
          committedAt: minutes(45),
        },
    failingJobs: status === 'failed' ? ['lint', 'e2e-playwright'] : [],
    finishedAt: status === 'running' || noCommit ? null : minutes(12),
    durationSeconds: status === 'running' || noCommit ? null : 252,
    runUrl: `https://example.com/${fullName}/actions/runs/1`,
    stale: false,
    staleSince: null,
  };
}

const MAIN_BRANCH_ROWS = [
  mainBranch('github', 'example-org/api-gateway', 'failed'),
  mainBranch('forgejo', 'sandbox/dotfiles', 'failed', 'master'),
  mainBranch('github', 'alrayyes/forge-dashboard', 'running'),
  mainBranch('github', 'example-org/wiki', 'passed'),
  mainBranch('github', 'example-org/docs-site', 'passed'),
  mainBranch('forgejo', 'sandbox/vps-docker', 'passed'),
  mainBranch('forgejo', 'sandbox/scratch', 'none', 'master'),
];

const MAIN_BRANCHES = {
  generatedAt: new Date().toISOString(),
  counts: {
    failed: 2,
    running: 1,
    passed: 3,
    none: 1,
    total: MAIN_BRANCH_ROWS.length,
  },
  branches: MAIN_BRANCH_ROWS,
};

// Fixture repos for the webhooks page (/api/dashboard's `repos` list).
const REPOS = [
  {
    forge: 'github',
    fullName: 'alrayyes/forge-dashboard',
    hasWebhook: true,
    canManageWebhooks: true,
  },
  {
    forge: 'github',
    fullName: 'example-org/wiki',
    hasWebhook: true,
    canManageWebhooks: true,
  },
  {
    forge: 'github',
    fullName: 'example-org/api-gateway',
    hasWebhook: false,
    canManageWebhooks: true,
  },
  {
    forge: 'github',
    fullName: 'example-org/docs-site',
    hasWebhook: false,
    canManageWebhooks: true,
  },
  {
    forge: 'forgejo',
    fullName: 'sandbox/vps-docker',
    hasWebhook: true,
    canManageWebhooks: true,
  },
  {
    forge: 'forgejo',
    fullName: 'sandbox/dotfiles',
    hasWebhook: false,
    canManageWebhooks: true,
  },
];

// One entry per page. `ready` only matches once the page shows real
// content, so a spinner or an error state is never shot.
// In menu order, which is the order the README lists them in.
const PAGES = [
  {
    name: 'branches',
    url: '/',
    ready: '[data-testid="main-branch-row"]',
  },
  {
    name: 'pull-requests',
    url: '/pull-requests.html',
    ready: '#stat-prs:not(:text("–"))',
  },
  { name: 'issues', url: '/issues.html', ready: 'a[href*="issues/145"]' },
  { name: 'releases', url: '/releases.html', ready: '#pr-rows .row' },
  { name: 'bots', url: '/bots.html', ready: '#pr-rows .row' },
  { name: 'insights', url: '/insights.html', ready: '.insights-header h1' },
  { name: 'webhooks', url: '/webhooks.html', ready: '#webhooks-rows tr' },
  { name: 'settings', url: '/settings.html', ready: 'h1' },
  { name: 'admin', url: '/admin.html', ready: 'h1' },
];

const THEMES = ['light', 'dark'] as const;

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    timezoneId: 'UTC',
    locale: 'en-US',
  });
  const page = await context.newPage();

  await addVirtualAuthenticator(page);
  await page.goto(`${BASE_URL}/login.html`);
  await page.click('#show-register');
  await page.fill('#register-username', 'demo-user');
  await page.fill('#register-display-name', 'Demo User');
  await page.click('#register-submit');
  await page.waitForURL(`${BASE_URL}/`, { timeout: 10000 });

  // The first registered user is the admin, so this one session covers
  // the admin page too. Give that page a second registered user and an
  // unredeemed invite, both with fictional names, so its tables aren't
  // empty. The invite goes through the admin session's own cookies.
  const colleague = await page.request.post(`${BASE_URL}/api/admin/invites`, {
    data: { username: 'demo-colleague', displayName: 'Demo Colleague' },
  });
  const { token } = await colleague.json();
  const colleagueContext = await browser.newContext();
  const colleaguePage = await colleagueContext.newPage();
  await addVirtualAuthenticator(colleaguePage);
  await colleaguePage.goto(
    `${BASE_URL}/login.html?invite=${encodeURIComponent(token)}&username=demo-colleague`,
  );
  await colleaguePage.click('#register-submit');
  await colleaguePage.waitForURL(`${BASE_URL}/`, { timeout: 10000 });
  await colleagueContext.close();
  await page.request.post(`${BASE_URL}/api/admin/invites`, {
    data: { username: 'demo-guest', displayName: 'Demo Guest' },
  });

  // The live stream is aborted so nothing replaces the fixture after the
  // page loads.
  await page.route('**/api/dashboard/stream', (route) => route.abort());
  await page.route('**/api/main-branches', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MAIN_BRANCHES),
    }),
  );
  await page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...SNAPSHOT, repos: REPOS }),
    }),
  );

  for (const theme of THEMES) {
    // #352: theme is a Settings-only control now, not a header toggle —
    // same real PUT tests/theme-helper.ts's setTheme uses.
    await page.evaluate(
      (t) =>
        fetch('/api/settings/theme', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ theme: t }),
        }),
      theme,
    );
    for (const { name, url, ready } of PAGES) {
      await page.goto(`${BASE_URL}${url}`);
      await page.waitForFunction(
        (t) => document.documentElement.getAttribute('data-theme') === t,
        theme,
      );
      await page.locator(ready).first().waitFor();
      await page.waitForLoadState('networkidle');
      await page.screenshot({
        path: path.join(OUT_DIR, `${name}-${theme}.png`),
      });
    }
  }
  await context.close();

  // Login is shot signed out: a fresh context with no session.
  for (const theme of THEMES) {
    const signedOut = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: theme,
    });
    const loginPage = await signedOut.newPage();
    await loginPage.goto(`${BASE_URL}/login.html`);
    await loginPage.locator('#login-username').waitFor();
    await loginPage.waitForLoadState('networkidle');
    await loginPage.screenshot({
      path: path.join(OUT_DIR, `login-${theme}.png`),
    });
    await signedOut.close();
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
