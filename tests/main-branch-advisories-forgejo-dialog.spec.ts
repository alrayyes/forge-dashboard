import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';
import { setTheme } from './theme-helper';

// A Forgejo row's advisories pill opens the same dialog, listing what OSV
// matched in the repository's lock files.
// https://github.com/alrayyes/forge-dashboard/issues/2671

const REPO = 'acme/lockfiles';

let advisoriesOver: object = {};

function branch() {
  return {
    forge: 'forgejo',
    fullName: REPO,
    url: `https://example.com/${REPO}`,
    branch: 'main',
    status: 'passed',
    commit: {
      sha: 'd98f3c2',
      subject: 'fix: a change',
      author: 'sre-dev',
      committedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
    failingJobs: [],
    finishedAt: null,
    durationSeconds: null,
    runUrl: `https://example.com/${REPO}/actions/runs/1`,
    checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
    latestRelease: null,
    staleSince: null,
    advisories: {
      state: 'known',
      count: 3,
      highest: 'critical',
      ...advisoriesOver,
    },
  };
}

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString();

function advisory(n: number, severity: string, over: object = {}) {
  return {
    number: n,
    state: 'open',
    severity,
    summary: `Flaw number ${n} in a dependency`,
    id: `GHSA-aaaa-bbbb-${n}`,
    ghsaId: `GHSA-aaaa-bbbb-${n}`,
    cveId: `CVE-2026-000${n}`,
    package: `pkg-${n}@1.${n}.0`,
    ecosystem: 'npm',
    manifestPath: 'package-lock.json',
    openedAt: daysAgo(n),
    patchedVersion: '2.0.0',
    description: 'Some **bold** text and a [link](https://example.org/x).',
    references: ['https://nvd.nist.gov/vuln/detail/CVE-1'],
    url: `https://osv.dev/vulnerability/GHSA-aaaa-bbbb-${n}`,
    ...over,
  };
}

const LIST = {
  state: 'known',
  advisories: [
    advisory(1, 'critical'),
    advisory(2, 'high', { manifestPath: 'go.mod, web/package-lock.json' }),
    advisory(3, 'low'),
  ],
};

async function open(page: Page, answer: (route: Route) => Promise<void>) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/main-branches/advisories*', answer);
  await page.route('**/api/v1/main-branches', (route) =>
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
        branches: [branch()],
      }),
    }),
  );
  await page.goto('/');
  await page.getByTestId('main-branch-advisories').click();
  await expect(page.getByTestId('advisories-dialog')).toBeVisible();
}

const json =
  (body: object, status = 200) =>
  (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

async function noViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, label).toEqual([]);
}

const noOverflow = async (page: Page, label: string) => {
  const dialog = page.getByTestId('advisories-dialog');
  const over = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(over, label).toBeLessThanOrEqual(0);
};

test.describe('Branches page advisories dialog for a Forgejo row', () => {
  test('lists the OSV advisories with severity, package, ecosystem and lock file', async ({
    page,
  }) => {
    let asked = '';
    await open(page, (route) => {
      asked = route.request().url();
      return json(LIST)(route);
    });

    expect(asked).toContain('forge=forgejo');
    expect(asked).toContain('fullName=acme%2Flockfiles');
    const rows = page.getByTestId('advisory-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Critical');
    await expect(rows.first()).toContainText('pkg-1@1.1.0 · npm');
    await expect(rows.first()).toContainText('Found in package-lock.json');
    await expect(rows.nth(1)).toContainText('go.mod, web/package-lock.json');
    await expect(page.getByTestId('advisories-dialog')).toContainText(
      'Forgejo',
    );
    // OSV has no page for a whole repository, so only a detail links out.
    await expect(page.getByTestId('advisory-open-on-forge')).toHaveCount(0);
  });

  test('a detail leaves out what OSV does not state and links to OSV', async ({
    page,
  }) => {
    await open(page, json(LIST));
    await page.locator('[data-number="1"]').click();

    const detail = page.getByTestId('advisory-detail');
    await expect(detail).toContainText('pkg-1@1.1.0 (npm)');
    await expect(detail).toContainText('Lock file');
    await expect(detail).toContainText('2.0.0');
    for (const absent of [
      'EPSS',
      'Severity score',
      'Weaknesses',
      'Vulnerable versions',
      'direct',
      'transitive',
    ]) {
      await expect(detail).not.toContainText(absent);
    }
    await expect(page.locator('.adv-description strong')).toHaveText('bold');
    await expect(page.getByTestId('advisory-open-on-forge')).toHaveText(
      'Open on OSV',
    );
    await expect(page.getByTestId('advisory-open-on-forge')).toHaveAttribute(
      'href',
      'https://osv.dev/vulnerability/GHSA-aaaa-bbbb-1',
    );
  });

  test('a detail states the score and vector when OSV gives one', async ({
    page,
  }) => {
    const vector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
    await open(
      page,
      json({
        ...LIST,
        advisories: [advisory(1, 'critical', { cvss: { score: 9.8, vector } })],
      }),
    );
    await page.locator('[data-number="1"]').click();

    const detail = page.getByTestId('advisory-detail');
    await expect(detail).toContainText('Severity score');
    await expect(detail).toContainText('9.8 (Critical)');
    await expect(detail).toContainText(vector);
    await noViolations(page, 'detail with a vector');
  });

  test('a failed read says why in Forgejo words, and a partly checked list says so', async ({
    page,
  }) => {
    await open(
      page,
      json({ state: 'unknown', reason: 'failed', advisories: [] }),
    );
    const unknown = page.getByTestId('advisories-unknown');
    await expect(unknown).toContainText('OSV could not be reached');
    await expect(unknown).not.toContainText(/Dependabot|permission|GitHub/);
    await noViolations(page, 'unknown');
    await page.keyboard.press('Escape');

    await page.unroute('**/api/v1/main-branches/advisories*');
    await page.route(
      '**/api/v1/main-branches/advisories*',
      json({ ...LIST, partial: true }),
    );
    await page.getByTestId('main-branch-advisories').click();
    await expect(page.getByTestId('advisories-partial')).toContainText(
      'left out',
    );
    await noViolations(page, 'partial note');
  });

  test('has no axe violations and no overflow, list and detail, at 1280 and 390px', async ({
    page,
  }) => {
    await open(page, json(LIST));
    await page.keyboard.press('Escape');

    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      await page.reload();
      for (const size of [
        { width: 1280, height: 800 },
        { width: 390, height: 800 },
      ]) {
        await page.setViewportSize(size);
        const label = `${theme} ${size.width}px`;
        await page.getByTestId('main-branch-advisories').click();
        await expect(page.getByTestId('advisory-row')).toHaveCount(3);
        await noViolations(page, `list ${label}`);
        await noOverflow(page, `list ${label}`);

        await page.locator('[data-number="1"]').click();
        await expect(page.getByTestId('advisory-detail')).toBeVisible();
        await noViolations(page, `detail ${label}`);
        await noOverflow(page, `detail ${label}`);
        await page.keyboard.press('Escape');
      }
    }
    await setTheme(page, 'light');
  });
});

test('a partly checked pill carries its hint in the accessible name', async ({
  page,
}) => {
  advisoriesOver = { partial: true };
  try {
    await open(page, json(LIST));
    await page.keyboard.press('Escape');
    const pill = page.getByTestId('main-branch-advisories');
    const hint = await pill.getAttribute('title');
    expect(hint).toBeTruthy();
    const name = await pill.getAttribute('aria-label');
    expect(name).toContain('(opens the advisories)');
    expect(name?.endsWith(hint ?? '')).toBe(true);
  } finally {
    advisoriesOver = {};
  }
});
