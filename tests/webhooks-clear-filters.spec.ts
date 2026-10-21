import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A "Clear filters" control on the Webhooks page, the one the other list pages
// have. It is always there, and enabled only while a filter differs from its default, resets forge,
// repo, status and sort, and the cleared state is saved like any other change.
// https://github.com/alrayyes/forge-dashboard/issues/1811

const REPOS = [
  { forge: 'github', fullName: 'acme/app', hasWebhook: true },
  { forge: 'forgejo', fullName: 'acme/infra', hasWebhook: false },
].map((r) => ({
  ...r,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
  canManageWebhooks: true,
}));

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos: REPOS,
      }),
    }),
  );
  await page.goto('/webhooks.html');
  await expect(page.locator('#webhooks-rows tr').first()).toBeVisible();
}

const clear = (page: Page) =>
  page.getByRole('button', { name: 'Clear filters' });
const serverCopy = async (page: Page) => {
  const body = await (
    await page.request.get('/api/settings/filter-state')
  ).json();
  return (body?.webhooks ?? {}) as Record<string, string>;
};
const cookieCopy = async (page: Page) => {
  const c = (await page.context().cookies()).find(
    (x) => x.name === 'forge-board-filters',
  );
  return ((c ? JSON.parse(decodeURIComponent(c.value)) : {}).webhooks ??
    {}) as Record<string, string>;
};

const DEFAULTS = {
  forge: '',
  repo: '',
  status: '',
  sort: 'fullName',
  dir: 'asc',
};

test.describe('webhooks: Clear filters', () => {
  test('is always there, and enabled only while a filter differs from its default', async ({
    page,
  }) => {
    await open(page);
    await expect(clear(page)).toBeVisible();
    await expect(clear(page)).toBeDisabled();

    await page.locator('#webhooks-status-filter').selectOption('pending');
    await expect(clear(page)).toBeEnabled();
    // A target big enough to hit (WCAG 2.5.8 asks for 24 px).
    const box = await clear(page).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(24);
    expect(box?.width).toBeGreaterThanOrEqual(24);
    await page.locator('#webhooks-status-filter').selectOption('');
    await expect(clear(page)).toBeDisabled();

    await page.locator('[data-sort-key="forge"]').click();
    await expect(clear(page)).toBeEnabled();
  });

  test('resets forge, repo, status, sort and direction, and the saved copies follow', async ({
    page,
  }) => {
    await open(page);
    await page.locator('input[data-filter="forge"][value="forgejo"]').check();
    await page.locator('#webhooks-repo-filter').fill('infra');
    await page.locator('#webhooks-status-filter').selectOption('pending');
    await page.locator('[data-sort-key="hasWebhook"]').click();
    await page.locator('[data-sort-key="hasWebhook"]').click();
    await expect
      .poll(() => serverCopy(page))
      .toMatchObject({
        forge: 'forgejo',
        repo: 'infra',
        status: 'pending',
        sort: 'hasWebhook',
        dir: 'desc',
      });

    await clear(page).click();

    await expect(
      page.locator('input[data-filter="forge"][value=""]'),
    ).toBeChecked();
    await expect(page.locator('#webhooks-repo-filter')).toHaveValue('');
    await expect(page.locator('#webhooks-status-filter')).toHaveValue('');
    await expect(
      page.locator('th:has([data-sort-key="fullName"])'),
    ).toHaveAttribute('aria-sort', 'ascending');
    await expect(clear(page)).toBeDisabled();
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);

    await expect.poll(() => serverCopy(page)).toMatchObject(DEFAULTS);
    expect(await cookieCopy(page)).toMatchObject(DEFAULTS);

    // It survives a reload, and a second browser (no cookie).
    await page.reload();
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);
    await expect(clear(page)).toBeDisabled();
    await page.context().clearCookies({ name: 'forge-board-filters' });
    await page.reload();
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);
    await expect(clear(page)).toBeDisabled();
  });

  test('in the empty state from an unmatched saved search it is there, reachable by keyboard, and clears it', async ({
    page,
  }) => {
    await open(page);
    await page.locator('#webhooks-repo-filter').fill('no-such-repo');
    await expect(page.locator('#webhooks-no-results')).toBeVisible();
    await expect
      .poll(() => serverCopy(page))
      .toMatchObject({
        repo: 'no-such-repo',
      });

    await page.reload();
    await expect(page.locator('#webhooks-no-results')).toBeVisible();
    await expect(page.locator('#webhooks-repo-filter')).toHaveValue(
      'no-such-repo',
    );
    await expect(clear(page)).toBeEnabled();

    await page.locator('#webhooks-repo-filter').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(clear(page)).toBeFocused();
    await page.keyboard.press('Enter');
    // The button is now disabled and a browser drops focus from it, so focus
    // goes to the repo search and the status line says what happened.
    await expect(clear(page)).toBeDisabled();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      'webhooks-repo-filter',
    );

    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);
    await expect(page.locator('#webhooks-repo-filter')).toHaveValue('');
    await expect(page.locator('#webhooks-status')).toContainText(
      'Filters cleared.',
    );
    await expect.poll(() => serverCopy(page)).toMatchObject({ repo: '' });
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390]) {
      test(`has no axe violations with the control showing (${scheme}, ${width}px)`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 800 });
        await open(page);
        await page.locator('#webhooks-repo-filter').fill('no-such-repo');
        await expect(clear(page)).toBeEnabled();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});

test('on a phone the button is a 44 px target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open(page);
  await page.locator('#webhooks-status-filter').selectOption('pending');
  const box = await clear(page).boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(box?.width).toBeGreaterThanOrEqual(44);
  // Focus lands on the repo search after a keyboard clear, at phone width too,
  // and the status line announces it.
  await clear(page).focus();
  await page.keyboard.press('Enter');
  await expect(clear(page)).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    'webhooks-repo-filter',
  );
  await expect(page.locator('#webhooks-status')).toContainText(
    'Filters cleared.',
  );
});

test('each clear is announced once, and the notice goes when a filter changes', async ({
  page,
}) => {
  await open(page);
  // Record every text the polite live region takes on.
  await page.evaluate(() => {
    const w = window as unknown as { seen: string[] };
    w.seen = [];
    const el = document.getElementById('webhooks-status') as HTMLElement;
    new MutationObserver(() =>
      w.seen.push(el.textContent?.trim() ?? ''),
    ).observe(el, { childList: true, characterData: true, subtree: true });
  });
  const announced = () =>
    page.evaluate(
      () =>
        (window as unknown as { seen: string[] }).seen.filter(
          (t) => t === 'Filters cleared.',
        ).length,
    );
  const text = () => page.locator('#webhooks-status').innerText();

  for (const [round, key] of ['Enter', 'Space'].entries()) {
    await page.locator('#webhooks-status-filter').selectOption('pending');
    await expect.poll(text).toBe('');
    await clear(page).focus();
    await page.keyboard.press(key);
    await expect(page.locator('#webhooks-status')).toContainText(
      'Filters cleared.',
    );
    expect(await announced()).toBe(round + 1);
  }
  // Still there, then gone as soon as a filter changes.
  await page.locator('#webhooks-repo-filter').fill('a');
  await expect.poll(text).toBe('');
});

test('a mouse click clears without moving focus to the repo search', async ({
  page,
}) => {
  await open(page);
  await page.locator('#webhooks-status-filter').selectOption('pending');
  await clear(page).click();
  await expect(clear(page)).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement?.id)).not.toBe(
    'webhooks-repo-filter',
  );
});
