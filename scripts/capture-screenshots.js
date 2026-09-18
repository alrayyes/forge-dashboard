#!/usr/bin/env node
// Regenerates docs/screenshots/dashboard-{light,dark}.png against a real
// build of the binary, run by the release workflow's screenshots job —
// not a Playwright *test* (playwright.config.js only looks in tests/),
// so the main e2e suite never picks this up.
//
// The dashboard's own /api/dashboard fetch is mocked with fixture data,
// the same way tests/dashboard.spec.js's own route mocks work: this runs
// in CI with no live GitHub/Forgejo credentials, and a screenshot only
// needs to look like the real product, not show a real account's actual
// open pull requests — the same reason the registered display name,
// username, and every repo except this project's own are fictional
// rather than Ryan's real name or infrastructure (#250).

const path = require('node:path');
const { chromium } = require('@playwright/test');
const { addVirtualAuthenticator } = require('../tests/webauthn-helper');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

const SNAPSHOT = {
  generatedAt: new Date().toISOString(),
  forges: [
    { forge: 'github', reachable: true, repoCount: 6 },
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
  ],
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

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  await addVirtualAuthenticator(page);
  await page.goto(`${BASE_URL}/login.html`);
  await page.click('#show-register');
  await page.fill('#register-username', 'demo-user');
  await page.fill('#register-display-name', 'Demo User');
  await page.click('#register-submit');
  await page.waitForURL(`${BASE_URL}/`, { timeout: 10000 });

  await page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SNAPSHOT),
    }),
  );
  await page.reload();
  await page.waitForFunction(
    () => document.getElementById('stat-prs').textContent !== '–',
  );

  await page.screenshot({
    path: path.join(OUT_DIR, 'dashboard-light.png'),
  });

  // #352: theme is a Settings-only control now, not a header toggle —
  // same real PUT tests/theme-helper.js's setTheme uses, then a reload
  // so the layout's own theme sync picks it up.
  await page.evaluate(() =>
    fetch('/api/settings/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ theme: 'dark' }),
    }),
  );
  await page.reload();
  await page.waitForFunction(
    () => document.getElementById('stat-prs').textContent !== '–',
  );
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-theme') === 'dark',
  );
  await page.screenshot({
    path: path.join(OUT_DIR, 'dashboard-dark.png'),
  });

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
