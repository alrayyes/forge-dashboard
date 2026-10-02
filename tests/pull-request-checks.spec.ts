import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `pr-checks-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'PR Checks Test User',
  );
}

interface MockPR {
  forge: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  ci: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  mergeStatus: string;
  behind: boolean;
}

function makePR(overrides: Partial<MockPR> = {}): MockPR {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Add structured logging',
    url: 'https://example.com/42',
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    ...overrides,
  };
}

function mockDashboard(page: Page, forge: string, pr?: MockPR) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge, reachable: true, repoCount: 1 }],
        pullRequests: pr ? [pr] : [],
        issues: [],
      }),
    }),
  );
}

function mockChecks(page: Page, body: unknown, status = 200) {
  return page.route('**/api/pull-requests/checks*', (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
}

test.describe('pull request pipeline checks panel', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  // #636: inline on the row itself, not behind "More actions" — a
  // read-only drill-down reached on nearly every row with CI configured,
  // not the rare, mutating kind of action that menu exists for.
  test('a pull request with CI reported shows the View pipeline button inline, not behind More actions', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'View pipeline' }),
    ).toBeVisible();
  });

  test('a pull request with no CI at all shows no button', async ({ page }) => {
    await mockDashboard(page, 'github', makePR({ ci: 'none' }));
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'View pipeline' }),
    ).toHaveCount(0);
  });

  test('clicking View pipeline requests checks for that exact pull request and lists them', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    let requestURL = '';
    await mockChecks(page, {
      checks: [
        {
          name: 'build',
          state: 'success',
          url: 'https://github.com/alrayyes/forge-dashboard/runs/1',
        },
        {
          name: 'test',
          state: 'running',
          url: 'https://github.com/alrayyes/forge-dashboard/runs/2',
        },
      ],
    });
    page.on('request', (req) => {
      if (req.url().includes('/api/pull-requests/checks'))
        requestURL = req.url();
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'View pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('alrayyes/forge-dashboard#42');

    const items = dialog.locator('.pipeline-check');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('build');
    await expect(items.nth(0)).toContainText('Passed');
    await expect(items.nth(1)).toContainText('test');
    await expect(items.nth(1)).toContainText('Running');

    const buildLink = dialog.getByRole('link', { name: 'View run: build' });
    await expect(buildLink).toHaveAttribute(
      'href',
      'https://github.com/alrayyes/forge-dashboard/runs/1',
    );
    await expect(buildLink).toHaveAttribute('target', '_blank');
    await expect(buildLink).toHaveAttribute('rel', 'noopener');

    const url = new URL(requestURL);
    expect(url.searchParams.get('forge')).toBe('github');
    expect(url.searchParams.get('fullName')).toBe('alrayyes/forge-dashboard');
    expect(url.searchParams.get('number')).toBe('42');
  });

  test('a skipped check shows its status but no "View run" link', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        {
          name: 'build',
          state: 'success',
          url: 'https://github.com/alrayyes/forge-dashboard/runs/1',
        },
        {
          name: 'deploy',
          state: 'skipped',
          url: 'https://github.com/alrayyes/forge-dashboard/runs/2',
        },
      ],
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'View pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const items = dialog.locator('.pipeline-check');
    await expect(items).toHaveCount(2);
    await expect(items.nth(1)).toContainText('deploy');
    await expect(items.nth(1)).toContainText('Skipped');

    await expect(
      dialog.getByRole('link', { name: 'View run: build' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('link', { name: 'View run: deploy' }),
    ).toHaveCount(0);
  });

  test('a check with no URL (a legacy commit status set with no target_url) shows no "View run" link', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        {
          name: 'build',
          state: 'success',
          url: 'https://github.com/alrayyes/forge-dashboard/runs/1',
        },
        {
          name: 'legacy-ci',
          state: 'success',
          url: '',
        },
      ],
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'View pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const items = dialog.locator('.pipeline-check');
    await expect(items).toHaveCount(2);
    await expect(items.nth(1)).toContainText('legacy-ci');

    await expect(
      dialog.getByRole('link', { name: 'View run: build' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('link', { name: 'View run: legacy-ci' }),
    ).toHaveCount(0);
  });

  test('no checks at all shows a plain "no CI configured" message', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, { checks: [] });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'View pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toContainText(
      'No CI configured for this pull request.',
    );
  });

  // #681: required (blocks the merge) vs advisory, from the forge's own
  // branch protection. Absent `required` means the forge couldn't tell.
  test('checks with a known required flag are grouped Required first, then Advisory', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        { name: 'codecov', state: 'success', url: '', required: false },
        { name: 'build', state: 'success', url: '', required: true },
        { name: 'lint', state: 'failure', url: '', required: true },
        { name: 'docs', state: 'failure', url: '', required: false },
      ],
    });
    await page.reload();

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'View pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const required = dialog.getByRole('group', { name: /^Required/ });
    const advisory = dialog.getByRole('group', { name: /^Advisory/ });
    await expect(required).toContainText('Required (2)');
    await expect(advisory).toContainText('Advisory (2)');

    // Required comes first in the DOM, failing required checks first
    // within it.
    const groups = dialog.locator('.pipeline-group');
    await expect(groups.nth(0)).toContainText('Required');
    await expect(groups.nth(1)).toContainText('Advisory');
    const requiredItems = required.locator('.pipeline-check');
    await expect(requiredItems.nth(0)).toContainText('lint');
    await expect(requiredItems.nth(1)).toContainText('build');
    await expect(advisory.locator('.pipeline-check')).toHaveCount(2);
  });

  test('a failing required check is flagged "Blocking" in text, an advisory failure is not', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        { name: 'lint', state: 'failure', url: '', required: true },
        { name: 'build', state: 'success', url: '', required: true },
        { name: 'docs', state: 'failure', url: '', required: false },
      ],
    });
    await page.reload();

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'View pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const items = dialog.locator('.pipeline-check');
    await expect(
      items.filter({ hasText: 'lint' }).getByText('Blocking'),
    ).toBeVisible();
    await expect(
      items.filter({ hasText: 'build' }).getByText('Blocking'),
    ).toHaveCount(0);
    await expect(
      items.filter({ hasText: 'docs' }).getByText('Blocking'),
    ).toHaveCount(0);
  });

  test('with no known required flag on any check the flat list shows unchanged', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        { name: 'build', state: 'success', url: '' },
        { name: 'test', state: 'failure', url: '' },
      ],
    });
    await page.reload();

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'View pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog.locator('.pipeline-check')).toHaveCount(2);
    await expect(dialog.locator('.pipeline-group')).toHaveCount(0);
    await expect(dialog.getByText('Blocking')).toHaveCount(0);
  });

  test('checks of unknown required status sit apart from known groups, never in Advisory', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        { name: 'build', state: 'success', url: '', required: true },
        { name: 'mystery', state: 'success', url: '' },
      ],
    });
    await page.reload();

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'View pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog.getByRole('group', { name: /^Advisory/ })).toHaveCount(
      0,
    );
    await expect(
      dialog.getByRole('group', { name: /^Status unknown/ }),
    ).toContainText('mystery');
  });

  test('the grouped panel has no axe-core violations and Escape still closes it', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        {
          name: 'build',
          state: 'success',
          url: 'https://example.com/1',
          required: true,
        },
        {
          name: 'lint',
          state: 'failure',
          url: 'https://example.com/2',
          required: true,
        },
        {
          name: 'codecov',
          state: 'success',
          url: 'https://example.com/3',
          required: false,
        },
      ],
    });
    await page.reload();

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'View pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(
      dialog.getByRole('group', { name: /^Required/ }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('at phone width the grouped panel is a bottom sheet, traps focus and has no axe-core violations', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        {
          name: 'build',
          state: 'success',
          url: 'https://example.com/1',
          required: true,
        },
        {
          name: 'codecov',
          state: 'success',
          url: 'https://example.com/2',
          required: false,
        },
      ],
    });
    await page.reload();

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'View pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(
      dialog.getByRole('group', { name: /^Required/ }),
    ).toBeVisible();

    const box = await dialog.boundingBox();
    if (!box) throw new Error('dialog has no bounding box');
    // Anchored to the bottom edge, full width.
    expect(Math.round(box.y + box.height)).toBe(800);
    expect(Math.round(box.width)).toBe(390);

    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() => {
          // A modal dialog makes the page behind it inert: focus is in
          // the dialog, or has left the document for the browser's own
          // chrome (body), never on a page element behind it.
          const active = document.activeElement;
          return (
            active === document.body || !!active?.closest('#pipeline-dialog')
          );
        }),
      ).toBe(true);
    }

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a failed fetch shows an error and a Retry that re-fetches', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    let attempts = 0;
    await page.route('**/api/pull-requests/checks*', (route: Route) => {
      attempts += 1;
      if (attempts === 1) {
        return route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'github: unreachable' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checks: [
            { name: 'build', state: 'success', url: 'https://example.com/1' },
          ],
        }),
      });
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'View pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toContainText(/unreachable/i);
    // The dialog carries the error; the top banner is for global conditions.
    await expect(page.locator('#error-banner')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Retry' }).click();
    await expect(dialog.locator('.pipeline-check')).toHaveCount(1);
  });

  test('Escape closes the panel and returns focus to the row button', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, { checks: [] });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    // #636: View pipeline is a plain inline row button now, not a
    // "More actions" entry — closing the dialog rebuilds the row (same
    // as every other row action already does) and refocuses this same
    // button by its stable id, not a menu trigger.
    const viewPipeline = row.getByRole('button', { name: 'View pipeline' });
    await viewPipeline.click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(viewPipeline).toBeFocused();
  });

  test('the close button closes the panel', async ({ page }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, { checks: [] });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'View pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await dialog.getByRole('button', { name: 'Close pipeline checks' }).click();
    await expect(dialog).toBeHidden();
  });

  test('the open panel is reachable by keyboard and has no axe-core violations', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        { name: 'build', state: 'success', url: 'https://example.com/1' },
        { name: 'test', state: 'failure', url: 'https://example.com/2' },
      ],
    });
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'View pipeline' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Pipeline checks' }),
    ).toBeVisible();

    await page.keyboard.press('Tab');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
