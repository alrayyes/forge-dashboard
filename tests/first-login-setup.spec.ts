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
  const install = page.getByRole('link', {
    name: 'Install on GitHub (opens in a new tab)',
  });
  await expect(install).toHaveAttribute(
    'href',
    linkedSetupFacts.github.installUrl,
  );
  await expect(install).toHaveAttribute('target', '_blank');
  await expect(install).toHaveAttribute('rel', /noopener/);
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
  // The warning is announced, and the way to fix it opens GitHub in a new tab.
  await expect(page.getByRole('alert')).toContainText(
    'The app can see none of them yet',
  );
  const manage = page.getByRole('link', {
    name: 'Manage access on GitHub (opens in a new tab)',
  });
  await expect(manage).toHaveAttribute('target', '_blank');
  await expect(manage).toHaveAttribute('rel', /noopener/);
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
  await expect(page.getByText('Waiting for owner approval')).toBeVisible();
  // The waiting row has its own Check again, named for the row.
  await expect(
    page.getByRole('button', { name: 'Check again for An organization' }),
  ).toBeVisible();
});

test('Forgejo: static guidance, no pasted token anywhere', async ({ page }) => {
  await answerWith(page, base);
  await page.goto('/setup');
  await expect(
    page.getByText(linkedSetupFacts.forgejo.redirectUri),
  ).toBeVisible();
  await expect(page.getByText('Confidential client')).toBeVisible();
  // What the page lists is what the server's sign-in asks for, as it states.
  await expect(page.getByText('Permissions requested')).toBeVisible();
  await expect(
    page.getByText(linkedSetupFacts.forgejo.scopes.join(' ')),
  ).toBeVisible();
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

test('Forgejo: Copy puts the redirect URI on the clipboard and says so', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await answerWith(page, base);
  await page.goto('/setup');
  await page.getByRole('button', { name: 'Copy redirect URI' }).click();
  // Visible, and in a live region so a screen reader hears it.
  await expect(
    page.getByRole('status').filter({ hasText: 'Copied' }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    linkedSetupFacts.forgejo.redirectUri,
  );
});

test('Forgejo: the link to create the app appears once the address is valid and says it opens a new tab', async ({
  page,
}) => {
  await answerWith(page, base);
  await page.goto('/setup');
  const create = page.getByRole('link', {
    name: 'Create the app on your Forgejo (opens in a new tab)',
  });
  await expect(create).toHaveCount(0);
  await page.getByLabel('Instance address').fill('https://git.example.com');
  await expect(create).toHaveAttribute(
    'href',
    'https://git.example.com/user/settings/applications',
  );
  await expect(create).toHaveAttribute('target', '_blank');
  await expect(create).toHaveAttribute('rel', /noopener/);
});

async function failForgejo(page: Page, error: string, delayMs = 0) {
  await page.route(
    (url) => url.pathname === '/api/v1/connections/forgejo',
    async (route) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      await route.fulfill({ status: 400, json: { error } });
    },
  );
}

async function submitForgejo(page: Page) {
  await page.getByLabel('Instance address').fill('https://git.example.com');
  await page.getByLabel('Client ID').fill('demo-client');
  await page.getByRole('button', { name: /^Authorize with Forgejo/ }).click();
}

test('Forgejo: a refused Authorize shows an alert and moves focus to it', async ({
  page,
}) => {
  await answerWith(page, base);
  await failForgejo(page, 'That address is not a Forgejo instance.');
  await page.goto('/setup');
  await submitForgejo(page);
  const alert = page.getByRole('alert').filter({
    hasText: 'That address is not a Forgejo instance.',
  });
  await expect(alert).toBeVisible();
  await expect(alert).toBeFocused();
  await expect(page.getByLabel('Client ID')).toHaveAttribute(
    'aria-describedby',
    /forgejo-problem/,
  );
});

test('Forgejo: while Authorize is starting the form is busy and the button says so', async ({
  page,
}) => {
  await answerWith(page, base);
  await failForgejo(page, 'slow', 600);
  await page.goto('/setup');
  await submitForgejo(page);
  const busy = page.getByRole('button', { name: 'Authorizing…' });
  await expect(busy).toBeDisabled();
  await expect(page.locator('form[aria-busy="true"]')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Authorize with Forgejo' }),
  ).toBeEnabled();
});

// Each state the sweep above does not reach gets its own scan, once per
// scheme at the phone width.
const extraStates: Record<string, (page: Page) => Promise<void>> = {
  'the failed-attempt banner': async (page) => {
    await answerWith(page, base);
    await page.goto('/setup?error=access_denied');
    await page.getByRole('alert').waitFor();
  },
  'the Forgejo form error': async (page) => {
    await answerWith(page, base);
    await failForgejo(page, 'That address is not a Forgejo instance.');
    await page.goto('/setup');
    await submitForgejo(page);
    await page
      .getByRole('alert')
      .filter({ hasText: 'not a Forgejo' })
      .waitFor();
  },
  'a pending organization request': async (page) => {
    await answerWith(page, installApp);
    await page.goto('/setup?install=requested');
    await page.getByText('Waiting for owner approval').waitFor();
  },
  'the Copied state': async (page) => {
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    await answerWith(page, base);
    await page.goto('/setup');
    await page.getByRole('button', { name: 'Copy redirect URI' }).click();
    await page.getByRole('status').filter({ hasText: 'Copied' }).waitFor();
  },
};

for (const [name, reach] of Object.entries(extraStates)) {
  for (const scheme of schemes) {
    test(`${name}, ${scheme}, has no accessibility violations`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await reach(page);
      await expectNoViolations(page);
    });
  }
}

test('reflow: at 320px wide and 175% text nothing scrolls sideways', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const facts of [base, noRepositories]) {
    await answerWith(page, facts);
    await page.goto('/setup');
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.addStyleTag({ content: 'html { font-size: 175% !important; }' });
    // Name what sticks out, so a failure says where.
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .filter((e) => e.getBoundingClientRect().right > window.innerWidth)
        .map((e) => `${e.tagName.toLowerCase()}.${e.className}`),
    );
    expect(wide).toEqual([]);
  }
});

test('Sign out is on the page', async ({ page }) => {
  await answerWith(page, base);
  await page.goto('/setup');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

// The real server, no stand-in for /api/v1/setup: the shared fixture answers
// "linked" for every other spec, which would hide a broken gate, so these let
// the request through to the test server (nothing linked, nothing saved).
test.describe('the gate against the real server', () => {
  async function realSetup(page: Page) {
    await page.route(
      (url) => url.pathname === '/api/v1/setup',
      (route) => route.continue(),
    );
  }

  test('a board with nothing linked and nothing saved is sent to setup', async ({
    page,
  }) => {
    await realSetup(page);
    await page.goto('/pull-requests.html');
    await page.waitForURL('**/setup');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up your board' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Continue' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  for (const [what, saved] of [
    ['a saved username', { githubUsername: 'octo-demo' }],
    [
      'a saved token',
      { githubToken: 'ghp_demo0000000000000000000000000000000000' },
    ],
  ] as const) {
    test(`a board with ${what} is not sent to setup`, async ({ page }) => {
      await realSetup(page);
      const saveResult = await page.request.put('/api/v1/settings', {
        data: saved,
      });
      expect(saveResult.ok()).toBe(true);
      await page.goto('/pull-requests.html');
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(/pull-requests\.html$/);
    });
  }
});
