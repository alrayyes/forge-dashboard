import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `releases-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Releases Test');
}

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 1,
    title: 'A pull request',
    url: 'https://example.com/1',
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

function release(number: number, version: string, overrides = {}) {
  return makePR({
    number,
    title: `chore(main): release ${version}`,
    url: `https://example.com/${number}`,
    author: 'release-please[bot]',
    labels: [{ name: 'autorelease: pending', color: 'ededed' }],
    kind: 'release',
    ...overrides,
  });
}

function mockDashboard(page: Page, pullRequests: unknown[]) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
      }),
    }),
  );
}

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('Releases page (#1107)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('lists release pull requests only, each with its version, repo and CI status', async ({
    page,
  }) => {
    await mockDashboard(page, [
      release(10, '0.74.2', { repo: 'acme/ingress', ci: 'failure' }),
      makePR({ number: 2, title: 'Add structured logging' }),
      makePR({
        number: 3,
        title: 'Bump foo from 1 to 2',
        author: 'dependabot',
        kind: 'dependency',
      }),
    ]);
    await page.goto('/releases.html');

    const rows = page.locator('#pr-rows > .row');
    await expect(rows).toHaveCount(1);
    const row = rows.first();
    await expect(row).toContainText('acme/ingress');
    await expect(row).toContainText('v0.74.2');
    await expect(row.getByRole('button', { name: /Failing/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Releases' })).toBeVisible();
    await expect(page).toHaveTitle(/Releases/);
  });

  test('a release that can merge offers Merge; one that cannot is greyed out with the reason', async ({
    page,
  }) => {
    await mockDashboard(page, [
      release(10, '0.74.2', { repo: 'acme/ready' }),
      release(11, '1.12.0', {
        repo: 'acme/waiting',
        ci: 'pending',
        mergeStatus: 'blocked',
      }),
    ]);
    await page.goto('/releases.html');

    const ready = page.locator('#pr-rows > .row', { hasText: 'acme/ready' });
    await expect(
      ready.getByRole('button', { name: 'Merge', exact: true }),
    ).not.toHaveAttribute('aria-disabled', 'true');

    const waiting = page.locator('#pr-rows > .row', {
      hasText: 'acme/waiting',
    });
    await expect(
      waiting.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(waiting).toContainText('Waiting for CI to finish');
  });

  test('a release that is behind offers Update branch and says why nothing else will update it', async ({
    page,
  }) => {
    await mockDashboard(page, [
      release(10, '0.18.4', { behind: true, mergeStatus: 'blocked' }),
    ]);
    await page.goto('/releases.html');

    const row = page.locator('#pr-rows > .row').first();
    await expect(
      row.getByRole('button', { name: 'Update branch' }),
    ).toBeVisible();
    await expect(row).toContainText(
      "release-please won't update this pull request",
    );
  });

  test('says nothing is waiting to ship when no release pull request is open', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR({ number: 2 })]);
    await page.goto('/releases.html');

    await expect(page.locator('#pr-empty')).toBeVisible();
    await expect(page.locator('#pr-empty')).toContainText(
      'Nothing is waiting to ship',
    );
    await expect(page.locator('#pr-rows > .row')).toHaveCount(0);
  });

  test('the header links to it, and it marks itself as the current page', async ({
    page,
  }) => {
    await mockDashboard(page, [release(10, '0.74.2')]);
    await page.goto('/');
    const link = page.locator('header').getByRole('link', { name: 'Releases' });
    await link.click();
    await expect(page).toHaveURL(/\/releases\.html$/);
    await expect(
      page.locator('header').getByRole('link', { name: 'Releases' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('has no axe-core violations at desktop and phone width', async ({
    page,
  }) => {
    await mockDashboard(page, [
      release(10, '0.74.2'),
      release(11, '0.18.4', { behind: true, mergeStatus: 'blocked' }),
    ]);
    await page.goto('/releases.html');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    expect(
      (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations,
    ).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations,
    ).toEqual([]);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
