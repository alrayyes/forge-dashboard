import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { linkedSetupFacts } from './fixtures';
import { test } from './server-fixture';

// The first-login "Set up your board" page (#4026). The page reads the facts
// from GET /api/v1/setup and decides the steps itself, so each state here is a
// stand-in answer, and the gate is the real server with no forge linked.

type Facts = typeof linkedSetupFacts;

const base: Facts = {
  ...linkedSetupFacts,
  github: {
    ...linkedSetupFacts.github,
    authorized: false,
    account: '',
    installations: [],
    repositoryCount: 0,
  },
};

const installApp: Facts = {
  ...base,
  github: { ...base.github, authorized: true, account: 'octo-demo' },
};

const noRepositories: Facts = {
  ...linkedSetupFacts,
  github: { ...linkedSetupFacts.github, repositoryCount: 0 },
};

const states: Record<string, Facts> = {
  'nothing linked': base,
  'install the app': installApp,
  'ready to continue': linkedSetupFacts,
  'no repositories visible': noRepositories,
};

async function answerWith(page: Page, facts: Facts) {
  await page.route(
    (url) => url.pathname === '/api/v1/setup',
    (route) => route.fulfill({ json: facts }),
  );
}

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const widths = [390, 1280];
const schemes = ['light', 'dark'] as const;

test('a board with no forge linked is sent to the setup page', async ({
  page,
}) => {
  await answerWith(page, base);
  await page.goto('/pull-requests.html');
  await page.waitForURL('**/setup');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Set up your board' }),
  ).toBeVisible();
});

test('a board with a forge linked is not sent anywhere', async ({ page }) => {
  await page.goto('/pull-requests.html');
  await expect(page).toHaveURL(/pull-requests\.html$/);
});

for (const [name, facts] of Object.entries(states)) {
  for (const width of widths) {
    for (const scheme of schemes) {
      test(`${name} at ${width}px, ${scheme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await answerWith(page, facts);
        await page.goto('/setup');
        await expect(
          page.getByRole('heading', { level: 1, name: 'Set up your board' }),
        ).toBeVisible();
        await expect(
          page.locator('[aria-current="step"]').first(),
        ).toBeVisible();
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        );
        expect(overflow).toBe(false);
        await expectNoViolations(page);
      });
    }
  }
}

test('nothing linked: Continue is shut and says why', async ({ page }) => {
  await answerWith(page, base);
  await page.goto('/setup');
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(
    page.getByText('Set up GitHub or Forgejo to continue'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Authorize with GitHub' }),
  ).toBeVisible();
});

test('authorized, not installed: the account row and the install link', async ({
  page,
}) => {
  await answerWith(page, installApp);
  await page.goto('/setup');
  await expect(page.getByText('octo-demo')).toBeVisible();
  await expect(page.getByText('Not installed')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Install on GitHub' }),
  ).toHaveAttribute('href', linkedSetupFacts.github.installUrl);
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
});

test('ready: Continue opens the board', async ({ page }) => {
  await answerWith(page, linkedSetupFacts);
  await page.goto('/setup');
  await expect(page.getByText('3 repositories found')).toBeVisible();
  await page.getByRole('link', { name: 'Continue' }).click();
  await page.waitForURL(/\/(index\.html)?$/);
});

test('no repositories: says so and offers Check again', async ({ page }) => {
  await answerWith(page, noRepositories);
  await page.goto('/setup');
  await expect(page.getByText('No repositories yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
});

test('a failed attempt names the cause, an unknown code gets the fallback', async ({
  page,
}) => {
  await answerWith(page, base);
  await page.goto('/setup?error=access_denied');
  await expect(page.getByRole('alert')).toContainText('cancelled or denied');
  await page.goto('/setup?error=something_new');
  await expect(page.getByRole('alert')).toContainText('nothing was saved');
});

test('a pending organization request shows as waiting', async ({ page }) => {
  await answerWith(page, installApp);
  await page.goto('/setup?install=requested');
  await expect(page.getByText('Waiting for approval')).toBeVisible();
});

test('Forgejo: static guidance, no pasted token anywhere', async ({ page }) => {
  await answerWith(page, base);
  await page.goto('/setup');
  await expect(
    page.getByText(linkedSetupFacts.forgejo.redirectUri),
  ).toBeVisible();
  await expect(page.getByText('Confidential client')).toBeVisible();
  await expect(page.getByLabel('Instance address')).toBeVisible();
  await expect(page.getByLabel('Client ID')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel(/token/i)).toHaveCount(0);
});

test('Forgejo: Authorize sends the address and Client ID and follows the answer', async ({
  page,
}) => {
  await answerWith(page, base);
  let sent: unknown;
  await page.route(
    (url) => url.pathname === '/api/v1/connections/forgejo',
    (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({
        json: {
          authorizeUrl: `${new URL(page.url()).origin}/setup?error=access_denied`,
        },
      });
    },
  );
  await page.goto('/setup');
  await page.getByLabel('Instance address').fill('https://git.example.com');
  await page.getByLabel('Client ID').fill('demo-client');
  await page.getByRole('button', { name: 'Authorize with Forgejo' }).click();
  await expect(page.getByRole('alert')).toContainText('cancelled or denied');
  expect(sent).toEqual({
    instanceUrl: 'https://git.example.com',
    clientId: 'demo-client',
  });
});

test('Sign out is on the page', async ({ page }) => {
  await answerWith(page, base);
  await page.goto('/setup');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});
