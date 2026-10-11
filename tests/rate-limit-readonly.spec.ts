import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';
import { rateLimit } from './severity-stand-in';

// #755: a rate-limited forge goes read-only. Its mutating controls are not
// drawn at all (not greyed), one banner per forge says so with the reset
// time, and everything comes back by itself at the reset.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `readonly-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Read-only User');
}

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: true,
    kind: 'regular',
    ...overrides,
  };
}

const inMinutes = (m: number) =>
  new Date(Date.now() + m * 60_000).toISOString();
const spent = (m = 12) => rateLimit(5000, 0, inMinutes(m));
const plenty = () => rateLimit(5000, 4000, inMinutes(30));

function mockDashboard(
  page: Page,
  forges: Record<string, unknown>[],
  pullRequests: Record<string, unknown>[],
) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges,
        pullRequests,
        issues: [],
      }),
    }),
  );
}

const github = (extra: Record<string, unknown>) => ({
  forge: 'github',
  reachable: true,
  repoCount: 1,
  ...extra,
});

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const MUTATING = [
  'Merge',
  'Update branch',
  'Close',
  'Enable auto-merge',
  'Dependabot: Rebase',
  'Renovate: Rebase',
];

test.describe('a rate-limited forge goes read-only (#755)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('its rows draw no mutating control at all, and keep the read-only ones', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [github({ rateLimitREST: spent(), rateLimitGraphQL: spent() })],
      [makePR()],
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(row.getByText('A pull request')).toBeVisible();
    for (const name of MUTATING) {
      await expect(row.getByRole('button', { name, exact: true })).toHaveCount(
        0,
      );
    }
    await expect(row.getByRole('button', { name: 'More actions' })).toHaveCount(
      0,
    );
    await expect(
      row.getByRole('button', { name: /Open pipeline/ }),
    ).toBeEnabled();
    await expect(
      row.getByRole('link', { name: /A pull request/ }),
    ).toBeVisible();
  });

  test('one banner for the forge says it is read-only until the reset, and what still works', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [github({ rateLimitREST: spent(), rateLimitGraphQL: spent() })],
      [makePR(), makePR({ number: 43 })],
    );
    await page.reload();

    const banner = page.locator('#rate-limit-banner');
    await expect(banner.locator('.rate-limit-banner-row')).toHaveCount(1);
    await expect(banner).toContainText(
      /GitHub is rate limited\. Read-only until \d{1,2}:\d{2}/,
    );
    const still = banner.getByText('What still works');
    await still.click();
    await expect(banner).toContainText('View pipeline');
    await expect(banner).toContainText('Open a pull request on the forge');
  });

  // #735: a rate-limit message says what the limit is, so it isn't taken for
  // a fault in the dashboard.
  test('the banner has a Why? that explains the budget and links to GitHub’s own rules', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [github({ rateLimitREST: spent(), rateLimitGraphQL: spent() })],
      [makePR()],
    );
    await page.reload();

    const banner = page.locator('#rate-limit-banner');
    const why = banner.getByText('Why?', { exact: true });
    // Reachable and operable from the keyboard, with a name that says what it is.
    await why.focus();
    await page.keyboard.press('Enter');
    await expect(banner).toContainText('request budget');
    await expect(banner).toContainText('not a fault in the dashboard');
    const docs = banner.getByRole('link', { name: /GitHub.*rate limit/i });
    await expect(docs).toHaveAttribute(
      'href',
      'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api',
    );
    await expect(docs).toHaveAttribute('target', '_blank');
    await expect(docs).toHaveAttribute('rel', /noopener/);
    expect(
      (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations,
    ).toEqual([]);
  });

  test('for Forgejo the explanation names the proxy, not GitHub’s rules', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [
        {
          forge: 'forgejo',
          reachable: true,
          repoCount: 1,
          rateLimitREST: spent(),
        },
      ],
      [makePR({ forge: 'forgejo' })],
    );
    await page.reload();

    const banner = page.locator('#rate-limit-banner');
    await banner.getByText('Why?', { exact: true }).click();
    await expect(banner).toContainText('proxy');
    await expect(banner.getByRole('link')).toHaveCount(0);
  });

  test('another forge is unaffected: its rows stay interactive and no banner names it', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [
        github({ rateLimitREST: spent(), rateLimitGraphQL: spent() }),
        { forge: 'forgejo', reachable: true, repoCount: 1 },
      ],
      [
        makePR({ number: 1, title: 'On GitHub' }),
        makePR({
          forge: 'forgejo',
          repo: 'alrayyes/other',
          number: 2,
          title: 'On Forgejo',
          url: 'https://example.com/forgejo/2',
        }),
      ],
    );
    await page.reload();

    const gh = page.locator('#pr-rows .row', { hasText: 'On GitHub' });
    const fj = page.locator('#pr-rows .row', { hasText: 'On Forgejo' });
    await expect(
      gh.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveCount(0);
    await expect(
      fj.getByRole('button', { name: 'Merge', exact: true }),
    ).toBeEnabled();
    const banner = page.locator('#rate-limit-banner');
    await expect(banner).toContainText('GitHub is rate limited');
    await expect(banner).not.toContainText('Forgejo');
  });

  test('only the GraphQL budget spent: Merge stays, auto-merge goes, and the banner names it', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [github({ rateLimitREST: plenty(), rateLimitGraphQL: spent() })],
      [makePR({ ci: 'pending', mergeStatus: 'blocked', behind: false })],
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge', exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByRole('button', { name: 'Close', exact: true }),
    ).toBeVisible();
    await expect(page.locator('#rate-limit-banner')).toContainText(
      /Enable auto-merge is unavailable until \d{1,2}:\d{2}/,
    );
  });

  test('only the REST budget spent: Merge and Close go, auto-merge stays', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [github({ rateLimitREST: spent(), rateLimitGraphQL: plenty() })],
      [makePR({ ci: 'pending', mergeStatus: 'blocked', behind: false })],
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge', exact: true }),
    ).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByRole('button', { name: 'Close', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('#rate-limit-banner')).toContainText(
      /Merge, Update branch, rebase and Close are unavailable until \d{1,2}:\d{2}/,
    );
  });

  test('controls return at the reset without a reload, with a polite toast, and the banner clears', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    await mockDashboard(
      page,
      [github({ rateLimitREST: spent(1), rateLimitGraphQL: spent(1) })],
      [makePR()],
    );
    await page.reload();

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveCount(0);
    await page.clock.fastForward(61_000);

    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('#feedback-toasts .feedback-toast'),
    ).toContainText('Rate limit reset, actions available again');
    await expect(page.locator('#rate-limit-banner')).toHaveCount(0);
  });

  test('has no axe-core violations and no horizontal scroll at desktop and 375px', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [github({ rateLimitREST: spent(), rateLimitGraphQL: spent() })],
      [makePR()],
    );
    await page.reload();
    await page
      .locator('#rate-limit-banner')
      .getByText('What still works')
      .click();
    const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
    expect(
      (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
    ).toEqual([]);

    await page.setViewportSize({ width: 375, height: 800 });
    expect(
      (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
    ).toEqual([]);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
