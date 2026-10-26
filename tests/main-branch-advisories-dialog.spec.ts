import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';
import { setTheme } from './theme-helper';

// A GitHub row's advisories pill opens a dialog with the repository's open
// advisories: a list sorted by severity, and a detail view for the row picked.
// https://github.com/alrayyes/forge-dashboard/issues/2610

const REPO = 'acme/critical';

function branch() {
  return {
    forge: 'github',
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
      count: 4,
      highest: 'critical',
      url: `https://example.com/${REPO}/security/dependabot`,
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
    ghsaId: `GHSA-aaaa-bbbb-${n}`,
    cveId: `CVE-2026-000${n}`,
    package: `pkg-${n}`,
    ecosystem: 'pip',
    scope: 'runtime',
    relationship: 'direct',
    manifestPath: 'requirements.txt',
    openedAt: daysAgo(n),
    vulnerableVersions: '< 2.0.0',
    patchedVersion: '2.0.0',
    cvss: {
      score: 9.1,
      vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    },
    weaknesses: [{ id: 'CWE-79', name: 'Cross-site Scripting' }],
    description: 'Some **bold** text and a [link](https://example.org/x).',
    references: [
      'https://nvd.nist.gov/vuln/detail/CVE-1',
      'javascript:alert(1)',
    ],
    url: `https://example.com/${REPO}/security/dependabot/${n}`,
    ...over,
  };
}

const LIST = {
  state: 'known',
  url: `https://example.com/${REPO}/security/dependabot`,
  advisories: [
    advisory(1, 'critical'),
    advisory(2, 'high'),
    advisory(3, 'high'),
    advisory(4, 'low'),
  ],
};

async function open(page: Page, answer: (route: Route) => Promise<void>) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/main-branches/advisories*', answer);
  await page.route('**/api/main-branches', (route) =>
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

test.describe('Branches page advisories dialog', () => {
  test('lists the advisories by severity, with the facts a row needs', async ({
    page,
  }) => {
    let asked = '';
    await open(page, (route) => {
      asked = route.request().url();
      return json(LIST)(route);
    });

    expect(asked).toContain('forge=github');
    expect(asked).toContain('fullName=acme%2Fcritical');
    const rows = page.getByTestId('advisory-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText('Critical');
    await expect(rows.first()).toContainText('Flaw number 1 in a dependency');
    await expect(rows.first()).toContainText('pkg-1 · pip');
    await expect(rows.first()).toContainText('requirements.txt');
    await expect(rows.first()).toContainText(/Opened \d+ \w+ ago/);
    await expect(page.getByTestId('advisory-open-on-forge')).toHaveAttribute(
      'href',
      `https://example.com/${REPO}/security/dependabot`,
    );
  });

  test('a severity chip narrows the list and says which is pressed', async ({
    page,
  }) => {
    await open(page, json(LIST));

    await page.getByTestId('advisory-filter-high').click();
    await expect(page.getByTestId('advisory-row')).toHaveCount(2);
    await expect(page.getByTestId('advisory-filter-high')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('advisory-filter-medium')).toHaveCount(0);
  });

  test('a row opens its detail, Back is first and returns to the same row and filter', async ({
    page,
  }) => {
    await open(page, json(LIST));
    await page.getByTestId('advisory-filter-high').click();

    await page.locator('[data-number="3"]').click();
    const back = page.getByTestId('advisory-back');
    await expect(back).toBeFocused();
    await expect(back).toHaveAccessibleName('Back to advisories');
    const detail = page.getByTestId('advisory-detail');
    await expect(detail).toContainText('pkg-3');
    await expect(detail).toContainText('< 2.0.0');
    await expect(detail).toContainText('9.1 (Critical)');
    await expect(detail).toContainText('CWE-79 Cross-site Scripting');
    await expect(page.locator('.adv-description strong')).toHaveText('bold');
    await expect(
      page.getByRole('link', { name: /nvd\.nist\.gov/ }),
    ).toHaveCount(1);
    await expect(page.locator('a[href^="javascript:" i]')).toHaveCount(0);

    await back.click();
    await expect(page.locator('[data-number="3"]')).toBeFocused();
    await expect(page.getByTestId('advisory-row')).toHaveCount(2);
    await expect(page.getByTestId('advisory-filter-high')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('Escape closes the dialog and focus goes back to the pill', async ({
    page,
  }) => {
    await open(page, json(LIST));

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('advisories-dialog')).toBeHidden();
    await expect(page.getByTestId('main-branch-advisories')).toBeFocused();
  });

  test('a list with none says so', async ({ page }) => {
    await open(page, json({ state: 'known', advisories: [] }));
    await expect(page.getByTestId('advisories-empty')).toBeVisible();
    await noViolations(page, 'empty');
  });

  test('a list GitHub would not give says why, and a failed read can be retried', async ({
    page,
  }) => {
    await open(
      page,
      json({ state: 'unknown', reason: 'refused', advisories: [] }),
    );
    await expect(page.getByTestId('advisories-unknown')).toContainText(
      'Dependabot alerts permission',
    );
    await page.keyboard.press('Escape');

    let calls = 0;
    await page.unroute('**/api/main-branches/advisories*');
    await page.route('**/api/main-branches/advisories*', (route) => {
      calls += 1;
      return calls === 1
        ? json({ error: 'boom' }, 502)(route)
        : json(LIST)(route);
    });
    await page.getByTestId('main-branch-advisories').click();
    await expect(page.getByRole('alert')).toContainText('boom');
    await page.getByTestId('advisories-retry').click();
    await expect(page.getByTestId('advisory-row')).toHaveCount(4);
  });

  test('has no axe violations and no overflow, list and detail, both themes at 1280 and 390px', async ({
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
        await expect(page.getByTestId('advisory-row')).toHaveCount(4);
        await noViolations(page, `list ${label}`);
        await noOverflow(page, `list ${label}`);

        await page.locator('[data-number="1"]').click();
        await expect(page.getByTestId('advisory-detail')).toBeVisible();
        await expect(page.locator('.adv-description strong')).toBeVisible();
        await noViolations(page, `detail ${label}`);
        await noOverflow(page, `detail ${label}`);
        await page.keyboard.press('Escape');
      }
    }
    await setTheme(page, 'light');
  });
});
