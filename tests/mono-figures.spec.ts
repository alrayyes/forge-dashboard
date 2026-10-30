import { expect, type Locator, type Route } from '@playwright/test';
import { test } from './server-fixture';

// Versions, commit hashes and numbers read in the app's own mono face
// (IBM Plex Mono) with tabular figures, so digits line up and a hash is easy
// to tell from prose. Prose that happens to hold digits stays in the sans face.
// https://github.com/alrayyes/forge-dashboard/issues/1754

async function figures(locator: Locator) {
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { family: cs.fontFamily, numeric: cs.fontVariantNumeric };
  });
}

async function expectMono(locator: Locator) {
  const { family, numeric } = await figures(locator);
  expect(family).toContain('IBM Plex Mono');
  expect(numeric).toContain('tabular-nums');
}

async function expectSans(locator: Locator) {
  const { family } = await figures(locator);
  expect(family).toContain('IBM Plex Sans');
  expect(family).not.toContain('IBM Plex Mono');
}

const RELEASES = [
  {
    version: '1.4.0',
    date: '2026-10-10',
    url: 'https://github.com/o/r/releases/tag/v1.4.0',
    notes: [
      '### Features',
      '',
      '* **api:** keep 3 retries per call ([#123](https://github.com/o/r/pull/123)) ([a1b2c3d](https://github.com/o/r/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678))',
      '',
      '### Bug Fixes',
      '',
      '* handle 2 empty lists ([#98](https://github.com/o/r/pull/98)) ([0f9e8d7](https://github.com/o/r/commit/0f9e8d7c6b5a49382716f5e4d3c2b1a098765432))',
    ].join('\n'),
  },
  {
    version: '1.3.2',
    date: '2026-10-01',
    url: 'https://github.com/o/r/releases/tag/v1.3.2',
    notes:
      '### Bug Fixes\n\n* retry after 30 seconds ([#7](https://github.com/o/r/pull/7))',
  },
];

test.describe('mono face and tabular figures (#1754)', () => {
  test('changelog: versions, pull request numbers and hashes are mono, prose stays sans', async ({
    page,
  }) => {
    await page.route('**/changelog.json', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ releases: RELEASES }),
      }),
    );
    await page.goto('/changelog.html');
    await expect(page.locator('.release')).toHaveCount(2);

    const versions = page.locator('.release h2 a');
    await expect(versions).toHaveCount(2);
    for (let i = 0; i < 2; i++) await expectMono(versions.nth(i));

    const notes = page.locator('.release-notes');
    const prs = notes.getByRole('link', { name: /^#\d+$/ });
    await expect(prs).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expectMono(prs.nth(i));

    const hashes = notes.getByRole('link', { name: /^[0-9a-f]{7}$/ });
    await expect(hashes).toHaveCount(2);
    for (let i = 0; i < 2; i++) await expectMono(hashes.nth(i));

    // The prose around them ("3 retries", "30 seconds") and the date stay sans.
    await expectSans(notes.locator('li').first());
    await expectSans(page.locator('.release-date').first());
    await expectSans(notes.locator('h3').first());
  });

  test('insights: numeric table cells are mono, their row labels stay sans', async ({
    page,
  }) => {
    await page.route('**/api/v1/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [
            {
              forge: 'github',
              repo: 'o/r',
              number: 1,
              title: 'A pull request',
              url: 'https://github.com/o/r/pull/1',
              author: 'someone',
              draft: false,
              labels: [],
              createdAt: new Date(Date.now() - 36e5).toISOString(),
              updatedAt: new Date().toISOString(),
              ci: 'success',
            },
          ],
          issues: [],
        }),
      }),
    );
    await page.goto('/insights.html');
    const cells = page.locator('td.num');
    await expect(cells.first()).toBeVisible();
    const count = await cells.count();
    expect(count).toBeGreaterThanOrEqual(9);
    for (let i = 0; i < count; i++) await expectMono(cells.nth(i));

    await expectSans(page.locator('#ci-status-table td:not(.num)').first());
  });

  test('branches: commit hashes are mono', async ({ page }) => {
    const now = new Date().toISOString();
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
    await page.route('**/api/v1/main-branches', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: now,
          counts: { failed: 1, passed: 1, running: 0, none: 0, total: 2 },
          branches: ['acme/one', 'acme/two'].map((fullName, i) => ({
            forge: 'github',
            fullName,
            url: `https://example.com/${fullName}`,
            branch: 'main',
            status: i === 0 ? 'failed' : 'passed',
            commit: {
              sha: i === 0 ? 'd98f3c2' : '0a1b2c3',
              subject: `fix: retry 3 times in ${fullName}`,
              author: 'sre-dev',
              committedAt: now,
            },
            failingJobs: i === 0 ? ['lint'] : [],
            finishedAt: now,
            durationSeconds: 252,
            runUrl: `https://example.com/${fullName}/actions/runs/1`,
            staleSince: null,
          })),
        }),
      }),
    );
    await page.goto('/');
    const shas = page.locator('.mb-sha');
    await expect(shas).toHaveCount(2);
    for (let i = 0; i < 2; i++) await expectMono(shas.nth(i));
  });

  test('settings: webhook URLs, the secret and a new API token are mono', async ({
    page,
  }) => {
    await page.goto('/settings.html#integrations');
    for (const id of [
      'webhook-url-github',
      'webhook-url-forgejo',
      'webhook-secret',
    ]) {
      await expectMono(page.locator(`#${id}`));
    }
    await page.locator('#token-label').fill('laptop');
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.locator('#token-reveal-value')).not.toHaveValue('');
    await expectMono(page.locator('#token-reveal-value'));

    // A text field for prose stays sans.
    await expectSans(page.locator('#token-label'));
  });
});
