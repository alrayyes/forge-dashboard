#!/usr/bin/env node
// Regenerates docs/screenshots/<page>-{light,dark}.png for every page in the
// menu (branches, pull requests, issues, releases, bots, insights, webhooks,
// settings), the pipeline checks panel, the pull request dialogs
// (a pull request, a release, a bot, and the phone sheet) and the login page
// (the footer pages are left out) against a real build of the binary, run by
// the release workflow's screenshots job — not a Playwright *test*
// (playwright.config.js only looks in tests/), so the main e2e suite never
// picks this up.
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
import { serveChecks } from '../tests/checks-feed-helper';
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
  status: 'failed' | 'running' | 'passed' | 'cancelled' | 'none',
  branch = 'main',
  minutesAgo = 45,
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
          committedAt: minutes(minutesAgo),
        },
    failingJobs: status === 'failed' ? ['lint', 'e2e-playwright'] : [],
    finishedAt: status === 'running' || noCommit ? null : minutes(12),
    durationSeconds: status === 'running' || noCommit ? null : 252,
    runUrl: `https://example.com/${fullName}/actions/runs/1`,
    staleSince: null,
  };
}

const MAIN_BRANCH_ROWS = [
  mainBranch('github', 'example-org/api-gateway', 'failed', 'main', 10),
  mainBranch('forgejo', 'sandbox/dotfiles', 'failed', 'master', 20),
  mainBranch('github', 'alrayyes/forge-dashboard', 'running', 'main', 30),
  mainBranch('github', 'example-org/wiki', 'passed', 'main', 40),
  mainBranch('github', 'example-org/docs-site', 'passed', 'main', 50),
  mainBranch('forgejo', 'sandbox/vps-docker', 'passed', 'main', 60),
  mainBranch('forgejo', 'sandbox/scratch', 'none', 'master'),
];

const MAIN_BRANCHES = {
  generatedAt: new Date().toISOString(),
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

// The pipeline checks panel of pull request #139 (its CI pill): one check
// in every state the panel shows, a required failure with its failed step and
// log excerpt, and one that is advisory. Fictional job names and URLs (#251).
const CHECKS = {
  checks: [
    {
      name: 'test',
      state: 'failure',
      url: 'https://github.com/alrayyes/forge-dashboard/actions/runs/1/job/1',
      required: true,
      durationSeconds: 94,
      failedStep: 'Run go test ./...',
      excerpt: [
        '--- FAIL: TestStore_ConcurrentWriters (0.41s)',
        '    store_test.go:88: database is locked (SQLITE_BUSY)',
        'FAIL',
        'FAIL\tgithub.com/alrayyes/forge-dashboard/internal/store\t0.45s',
      ].join('\n'),
    },
    {
      name: 'lint',
      state: 'success',
      url: 'https://github.com/alrayyes/forge-dashboard/actions/runs/1/job/2',
      required: true,
      durationSeconds: 41,
    },
    {
      name: 'build',
      state: 'success',
      url: 'https://github.com/alrayyes/forge-dashboard/actions/runs/1/job/3',
      required: true,
      durationSeconds: 128,
    },
    {
      name: 'e2e (shard 1/4)',
      state: 'running',
      url: 'https://github.com/alrayyes/forge-dashboard/actions/runs/1/job/4',
      required: true,
    },
    {
      name: 'e2e (shard 2/4)',
      state: 'queued',
      url: 'https://github.com/alrayyes/forge-dashboard/actions/runs/1/job/5',
      required: true,
    },
    {
      name: 'lighthouse',
      state: 'cancelled',
      url: 'https://github.com/alrayyes/forge-dashboard/actions/runs/1/job/6',
      required: false,
      durationSeconds: 12,
    },
    {
      name: 'auto-merge',
      state: 'skipped',
      url: 'https://github.com/alrayyes/forge-dashboard/actions/runs/1/job/7',
      required: false,
    },
  ],
};

// Placeholder avatars: a flat coloured circle with an initial, served for
// every avatar URL below so no real person's picture appears (#251).
function avatarSvg(initial: string, colour: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="${colour}"/><text x="32" y="43" font-family="sans-serif" font-size="30" text-anchor="middle" fill="#fff">${initial}</text></svg>`;
}
const AVATARS: Record<string, string> = {
  'demo-user': avatarSvg('D', '#6f42c1'),
  'demo-colleague': avatarSvg('C', '#0a7d5a'),
  'demo-reviewer': avatarSvg('R', '#b35c00'),
};
const avatarUrl = (login: string) =>
  `https://avatars.example.invalid/${login}.svg`;

function reactions(up: string[], down: string[]) {
  return {
    thumbsUp: { count: up.length, logins: up },
    thumbsDown: { count: down.length, logins: down },
  };
}

function comment(
  id: string,
  login: string,
  text: string,
  minutes: number,
  react = reactions([], []),
) {
  return {
    id,
    author: { login, avatarUrl: avatarUrl(login) },
    createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    updatedAt: null,
    edited: false,
    text,
    format: 'markdown',
    truncated: false,
    reactions: react,
  };
}

function body(text: string, react = reactions([], [])) {
  return {
    text,
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: react,
  };
}

// GET /api/pull-requests/details payloads, keyed by pull request number.
// Fictional text throughout (#251).
const DETAILS: Record<number, unknown> = {
  142: {
    description: body(
      [
        'Keeps the repo and author filters scoped to the forge picked in the',
        'header, so a Forgejo-only view stops offering GitHub repos.',
        '',
        '```ts',
        'const repos = rows.filter((r) => r.forge === active).map((r) => r.repo);',
        '```',
        '',
        '- [x] Scope the repo filter to the active forge',
        '- [x] Scope the author filter to the active forge',
        '- [ ] Drop saved selections for repos that vanish',
      ].join('\n'),
      reactions(['demo-colleague', 'demo-reviewer'], ['demo-guest']),
    ),
    comments: [
      comment(
        '1',
        'demo-reviewer',
        'Looks right. Could the saved selection also drop repos that vanish?',
        180,
        reactions(['demo-user'], []),
      ),
      comment(
        '2',
        'demo-user',
        'Good catch, **fixed** in the latest push.',
        95,
        reactions(['demo-reviewer', 'demo-colleague'], []),
      ),
      comment(
        '3',
        'demo-colleague',
        'Approved from my side. Merging once CI is green.',
        20,
        reactions(['demo-user'], ['demo-guest']),
      ),
    ],
    commentCount: 3,
    commentsTruncated: false,
    releaseNotes: null,
  },
  143: {
    description: body('Release pull request.'),
    comments: [],
    commentCount: 0,
    commentsTruncated: false,
    releaseNotes: body(
      [
        '## 0.9.0',
        '',
        '### Features',
        '',
        '* keep repo and author filters scoped to the active forge',
        '* show a pull request conversation in a dialog',
        '',
        '### Bug fixes',
        '',
        '* fix SQLITE_BUSY under concurrent writers',
      ].join('\n'),
      reactions(['demo-colleague'], []),
    ),
  },
  88: {
    description: body(
      [
        'Bumps [vite](https://github.com/example-org/vite) from 8.0.3 to 8.1.0.',
        '',
        '## Release notes',
        '',
        '* Faster dependency pre-bundling',
        '* Fixes a regression in the dev server proxy',
        '',
        '## Commits',
        '',
        '* `a1b2c3d` chore: release 8.1.0',
        '* `e4f5a6b` fix(proxy): keep the host header',
      ].join('\n'),
    ),
    comments: [],
    commentCount: 0,
    commentsTruncated: false,
    releaseNotes: null,
  },
};

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
    ready: '#pr-rows .row',
  },
  { name: 'issues', url: '/issues.html', ready: '#issue-rows .row' },
  { name: 'releases', url: '/releases.html', ready: '#pr-rows .row' },
  { name: 'bots', url: '/bots.html', ready: '#pr-rows .row' },
  { name: 'insights', url: '/insights.html', ready: '.insights-header h1' },
  { name: 'webhooks', url: '/webhooks.html', ready: '#webhooks-rows tr' },
  { name: 'settings', url: '/settings.html', ready: 'h1' },
];

const THEMES = ['light', 'dark'] as const;

// Opens the pipeline checks panel from the failing fixture pull request's CI
// pill and shoots it. The panel is a dialog, so the page alone never shows it.
async function shootPipelineChecks(
  page: import('@playwright/test').Page,
  theme: (typeof THEMES)[number],
) {
  const row = page.locator('#pr-rows .row', { hasText: '#139' }).first();
  await row.getByRole('button', { name: 'Open pipeline' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
  await dialog.waitFor();
  await dialog.locator('.pipeline-check').first().waitFor();
  await page.waitForLoadState('networkidle');
  await page.screenshot({
    path: path.join(OUT_DIR, `pipeline-checks-${theme}.png`),
  });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
}

// Opens the details dialog on one fixture pull request (the title button
// in its row) and shoots it once the content, not the skeleton, is drawn.
async function shootDialog(
  page: import('@playwright/test').Page,
  number: number,
  name: string,
  theme: (typeof THEMES)[number],
  ready: string,
) {
  const row = page.locator('#pr-rows .row', { hasText: `#${number}` }).first();
  await row.getByRole('button', { name: new RegExp(`^#${number} `) }).click();
  const dialog = page.getByRole('dialog', { name: /^Pull request details/ });
  await dialog.waitFor();
  await dialog.locator(ready).first().waitFor();
  await page.waitForLoadState('networkidle');
  // Avatars are plain <img>s: wait until each has decoded.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('dialog[open] img')].every(
      (i) => (i as HTMLImageElement).complete,
    ),
  );
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-${theme}.png`) });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
}

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
  await page.click('#register-submit');
  await page.waitForURL(`${BASE_URL}/`, { timeout: 10000 });

  // The live stream is aborted so nothing replaces the fixture after the
  // page loads.
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
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
  // The pipeline panel reads its job list off the stream, so a stand-in
  // stream answers the page's watch with the fixture.
  await serveChecks(page, () => CHECKS.checks);

  await page.route('**/api/pull-requests/details*', (route) => {
    const number = Number(
      new URL(route.request().url()).searchParams.get('number'),
    );
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(DETAILS[number]),
    });
  });
  await page.route('https://avatars.example.invalid/*', (route) => {
    const login = path.basename(
      new URL(route.request().url()).pathname,
      '.svg',
    );
    return route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: AVATARS[login] ?? AVATARS['demo-user'],
    });
  });

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
      if (name === 'pull-requests') {
        await shootPipelineChecks(page, theme);
        // Taller than a page shot, so all three comments fit without scrolling.
        await page.setViewportSize({ width: 1280, height: 1330 });
        await shootDialog(page, 142, 'pull-request-dialog', theme, '.markdown');
        // The same dialog as the phone sheet, at 360px wide.
        await page.setViewportSize({ width: 360, height: 1150 });
        await shootDialog(page, 142, 'pull-request-sheet', theme, '.markdown');
        await page.setViewportSize({ width: 1280, height: 900 });
      }
      if (name === 'releases') {
        await shootDialog(page, 143, 'release-dialog', theme, '.markdown');
      }
      if (name === 'bots') {
        await shootDialog(page, 88, 'bot-dialog', theme, '.details-collapsed');
      }
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
    await loginPage.locator('#login-submit').waitFor();
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
