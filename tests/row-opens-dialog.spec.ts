import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// A pull request row opens its dialog from the title button, stretched over
// the whole row; the Details pill is gone. Mocks /api/dashboard and the
// details endpoint only and writes no per-user state, so it starts from the
// shared session. Two tests are the exception: one re-sorts the list and
// one clicks a label chip, and the server saves both for the user. On the
// shared user they changed what every later spec saw, so they have a user of
// their own.
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [{ name: 'kind/chore', color: 'cccccc' }],
    createdAt: ago(60),
    updatedAt: ago(5),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

const details = {
  description: {
    text: 'The **description**.',
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
};

async function mockDashboard(
  page: Page,
  pullRequests: unknown[],
  issues: unknown[] = [],
) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues,
      }),
    }),
  );
}

async function mockDetails(
  page: Page,
  status = 200,
  payload: unknown = details,
) {
  await page.route('**/api/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    }),
  );
}

const row = (page: Page, n = 42) =>
  page.locator('#pr-rows .row', { hasText: `#${n}` });
const titleButton = (page: Page, n = 42) =>
  row(page, n).getByRole('button', { name: new RegExp(`^#${n} `) });
const dialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });

test.describe('a pull request row opens its dialog', () => {
  test.beforeEach(async ({ page }) => {
    await mockDashboard(page, [makePR(42), makePR(43)]);
    await mockDetails(page);
    await page.goto('/pull-requests.html');
    await expect(row(page)).toBeVisible();
  });

  test('has one button named by number and title, no Details pill and no forge link', async ({
    page,
  }) => {
    await expect(titleButton(page)).toHaveCount(1);
    await expect(titleButton(page)).toHaveAccessibleName('#42 Pull request 42');
    await expect(
      row(page).getByRole('button', { name: /^Details/ }),
    ).toHaveCount(0);
    await expect(row(page).locator('.row-details')).toHaveCount(0);
    await expect(
      row(page).locator('a[href="https://example.com/42"]'),
    ).toHaveCount(0);
  });

  test('clicking the title opens the dialog, with its link to the forge', async ({
    page,
  }) => {
    await titleButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('strong')).toHaveText('description');
    const link = dialog(page).getByRole('link', { name: /Open on GitHub/ });
    await expect(link).toHaveAttribute('href', 'https://example.com/42');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('clicking a blank area of the row opens the dialog', async ({
    page,
  }) => {
    // force: the stretched overlay is the point; a real click hits it.
    await row(page).locator('.repo').click({ force: true });
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('Pull request 42');
  });

  test('Enter opens it, Escape closes it and focus returns to the title button', async ({
    page,
  }) => {
    await titleButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(titleButton(page)).toBeFocused();
  });

  test('dragging across the title to select text does not open the dialog', async ({
    page,
  }) => {
    const box = await titleButton(page).boundingBox();
    if (!box) throw new Error('no title box');
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(dialog(page)).toBeHidden();
  });

  test('a drag that ends outside the row does not swallow the next Enter', async ({
    page,
  }) => {
    const box = await row(page).boundingBox();
    if (!box) throw new Error('no row box');
    await page.mouse.move(box.x + 6, box.y + 6);
    await page.mouse.down();
    await page.mouse.move(box.x + 6, box.y + box.height + 120, { steps: 6 });
    await page.mouse.up();
    await expect(dialog(page)).toBeHidden();
    await titleButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
  });

  test('the focused title shows the accent ring', async ({ page }) => {
    await page.keyboard.press('Tab');
    await titleButton(page).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const outline = await titleButton(page).evaluate((el) => {
      const cs = getComputedStyle(el);
      return `${cs.outlineWidth} ${cs.outlineStyle}`;
    });
    expect(outline).toBe('2px solid');
  });

  test('has no axe-core violations closed or open', async ({ page }) => {
    const scan = () =>
      new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
    expect((await scan()).violations).toEqual([]);
    await titleButton(page).click();
    await expect(dialog(page).locator('strong')).toHaveText('description');
    expect((await scan()).violations).toEqual([]);
  });
});

test.describe('a row whose details cannot load', () => {
  test('still opens the dialog, with its own error state', async ({ page }) => {
    await mockDashboard(page, [makePR(42)]);
    await mockDetails(page, 502, { error: 'forge unreachable' });
    await page.goto('/pull-requests.html');
    await titleButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(
      dialog(page).getByRole('button', { name: 'Try again' }),
    ).toBeVisible();
  });
});

test.describe('on the other pages and on a phone', () => {
  test('Releases and Bots rows open the dialog too', async ({ page }) => {
    await mockDashboard(page, [
      makePR(42, { kind: 'release', title: 'chore(main): release 1.2.0' }),
      makePR(43, { kind: 'dependency', author: 'dependabot' }),
    ]);
    await mockDetails(page);
    for (const [path, n] of [
      ['/releases.html', 42],
      ['/bots.html', 43],
    ] as const) {
      await page.goto(path);
      await titleButton(page, n).click();
      await expect(dialog(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();
    }
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`at 360px the whole row is the tap target and nothing scrolls sideways (${scheme})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 360, height: 780 });
      await page.emulateMedia({ colorScheme: scheme });
      await mockDashboard(page, [makePR(42)]);
      await mockDetails(page);
      await page.goto('/pull-requests.html');
      await expect(row(page)).toBeVisible();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const box = await row(page).boundingBox();
      if (!box) throw new Error('no row box');
      await page.mouse.click(box.x + 6, box.y + 6);
      await expect(dialog(page)).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

test.describe('a pull request row opens its dialog: saved choices', () => {
  // Not the shared session: the server saves a re-sort and a label filter for
  // the user.
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      `row-opens-dialog-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'Row Opens Dialog',
    );
    await mockDashboard(page, [makePR(42), makePR(43)]);
    await mockDetails(page);
    await page.goto('/pull-requests.html');
    await expect(row(page)).toBeVisible();
  });

  test('focus returns to the new title button when the list was rebuilt meanwhile', async ({
    page,
  }) => {
    await page.evaluate(() => {
      (
        document.querySelector('#pr-rows .row .title') as HTMLElement & {
          __old?: boolean;
        }
      ).__old = true;
    });
    await titleButton(page).click();
    await expect(dialog(page)).toBeVisible();
    // Re-sort behind the modal: the rows are rebuilt.
    await page.evaluate(() => {
      const select = document.querySelector(
        '#pr-sort-select',
      ) as HTMLSelectElement;
      select.value = select.value === 'repo' ? 'updated' : 'repo';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(titleButton(page)).toBeFocused();
    const rebuilt = await titleButton(page).evaluate(
      (el) => !(el as HTMLElement & { __old?: boolean }).__old,
    );
    expect(rebuilt).toBe(true);
  });

  test('the CI pill and a label do what they did and do not open the dialog', async ({
    page,
  }) => {
    await row(page).getByRole('button', { name: 'Open pipeline' }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(
      page.getByRole('dialog', { name: 'Pipeline checks' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await row(page).locator('.label-chip').click();
    await expect(dialog(page)).toBeHidden();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
  });
});
