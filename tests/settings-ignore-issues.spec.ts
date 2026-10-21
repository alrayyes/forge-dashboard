import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #1630: the "Issues" section in Settings. The server half (storing, checking
// and applying the two settings) is a separate pull request, so this spec
// stands in for GET and PUT /api/settings with the shapes api/openapi.yaml
// describes. The user is the spec's own: Settings saves per account.
// https://github.com/alrayyes/forge-dashboard/issues/1630

interface Stored {
  hideDependencyDashboard: boolean;
  ignoredTitles: string[];
}

// A stand-in for the server: PUT replaces, as the contract says, and a
// pattern of "(" is refused the way the real check words it.
async function standInSettings(
  page: Page,
  initial: Partial<Stored> = {},
): Promise<{ stored: Stored; puts: Record<string, unknown>[] }> {
  const state = {
    stored: {
      hideDependencyDashboard: initial.hideDependencyDashboard ?? false,
      ignoredTitles: initial.ignoredTitles ?? [],
    },
    puts: [] as Record<string, unknown>[],
  };
  const response = () => ({
    githubUsername: '',
    githubTokenSet: false,
    githubAppInstallationId: 0,
    githubAppConfigured: false,
    forgejoUrl: '',
    forgejoUsername: '',
    forgejoTokenSet: false,
    webhookToken: 'webhook-token',
    webhookSecret: 'webhook-secret',
    renovateRebaseLabel: '',
    renovateAuthors: [],
    theme: '',
    ...state.stored,
  });
  await page.route(
    (url) => url.pathname === '/api/settings',
    async (route: Route) => {
      const request = route.request();
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as Record<string, unknown>;
        state.puts.push(body);
        const titles = (body.ignoredTitles ?? []) as string[];
        const bad = titles.findIndex((t) => t === '(');
        if (bad >= 0)
          return route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({
              error: `ignoredTitles entry ${bad + 1} ("("): missing closing )`,
              field: 'ignoredTitles',
            }),
          });
        state.stored = {
          hideDependencyDashboard: body.hideDependencyDashboard === true,
          ignoredTitles: titles,
        };
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response()),
      });
    },
  );
  return state as { stored: Stored; puts: Record<string, unknown>[] };
}

const section = (page: Page) => page.locator('#issue-settings');
const pattern = (page: Page) =>
  section(page).getByRole('textbox', { name: 'Pattern' });
const add = (page: Page) => section(page).getByRole('button', { name: 'Add' });
const save = (page: Page) => page.locator('#save-button');
const entries = (page: Page) => section(page).locator('#ignored-titles > li');
const hideBox = (page: Page) =>
  section(page).getByRole('checkbox', {
    name: 'Hide the Dependency Dashboard issue',
  });

async function addPattern(page: Page, text: string) {
  await pattern(page).fill(text);
  await add(page).click();
}

test.describe('Settings: Issues (#1630)', () => {
  test('has a labelled section with the checkbox, an empty state, and the syntax note', async ({
    page,
  }) => {
    await standInSettings(page);
    await page.goto('/settings.html#behaviour');
    await expect(
      section(page).getByRole('heading', { name: 'Issues' }),
    ).toBeVisible();
    await expect(hideBox(page)).not.toBeChecked();
    await expect(section(page).locator('#ignored-titles-empty')).toBeVisible();
    await expect(section(page).locator('#ignored-titles-empty')).toContainText(
      'No titles are ignored',
    );
    await expect(entries(page)).toHaveCount(0);
    await expect(section(page)).toContainText('RE2');
    await expect(section(page)).toContainText('lookahead');
    await expect(section(page)).toContainText('20');
  });

  test('adds a trimmed pattern, saves it, and brings it back on a reload', async ({
    page,
  }) => {
    const server = await standInSettings(page);
    await page.goto('/settings.html#behaviour');
    await addPattern(page, '  ^Weekly report  ');
    await expect(entries(page)).toHaveCount(1);
    await expect(entries(page).first()).toContainText('^Weekly report');
    await expect(pattern(page)).toHaveValue('');
    await expect(
      page.getByRole('button', { name: 'Remove ^Weekly report' }),
    ).toBeVisible();
    await expect(section(page).locator('#ignored-titles-empty')).toBeHidden();

    await save(page).click();
    await expect(page.locator('#status')).toHaveText('Saved.');
    expect(server.stored.ignoredTitles).toEqual(['^Weekly report']);

    await page.reload();
    await expect(entries(page)).toHaveCount(1);
    await expect(entries(page).first()).toContainText('^Weekly report');
  });

  test('a failed load turns Save off and sends nothing', async ({ page }) => {
    const puts: string[] = [];
    await page.route(
      (url) => url.pathname === '/api/settings',
      (route: Route) => {
        if (route.request().method() === 'PUT') puts.push('put');
        return route.fulfill({ status: 500, body: 'nope' });
      },
    );
    await page.goto('/settings.html#behaviour');
    await expect(page.locator('#status')).toContainText(
      'saving is turned off so nothing is overwritten',
    );
    await expect(save(page)).toBeDisabled();
    await page
      .locator('#settings-form')
      .evaluate((f: HTMLFormElement) => f.requestSubmit());
    expect(puts).toEqual([]);
  });

  test('text typed in Pattern but not added is added by Save', async ({
    page,
  }) => {
    const server = await standInSettings(page, {
      ignoredTitles: ['^Nightly'],
    });
    await page.goto('/settings.html#behaviour');
    await expect(entries(page)).toHaveCount(1);
    await pattern(page).fill('  ^Weekly report ');
    await save(page).click();
    await expect(page.locator('#status')).toHaveText('Saved.');
    expect(server.stored.ignoredTitles).toEqual(['^Nightly', '^Weekly report']);
    await expect(entries(page)).toHaveCount(2);
    await expect(pattern(page)).toHaveValue('');
  });

  test('typed text that cannot be added stops the save and says why', async ({
    page,
  }) => {
    const server = await standInSettings(page, {
      ignoredTitles: Array.from({ length: 20 }, (_, i) => `^Report ${i}`),
    });
    await page.goto('/settings.html#behaviour');
    await expect(entries(page)).toHaveCount(20);
    await pattern(page).fill('one more');
    await save(page).click();
    await expect(section(page).locator('#ignored-titles-error')).toContainText(
      'at most 20',
    );
    await expect(pattern(page)).toBeFocused();
    expect(server.puts).toEqual([]);
  });

  test('Remove moves focus to the next entry, then the previous, then Pattern', async ({
    page,
  }) => {
    await standInSettings(page, {
      ignoredTitles: ['^One', '^Two', '^Three'],
    });
    await page.goto('/settings.html#behaviour');
    await expect(entries(page)).toHaveCount(3);
    await page.getByRole('button', { name: 'Remove ^Two' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('button', { name: 'Remove ^Three' }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('button', { name: 'Remove ^One' }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pattern(page)).toBeFocused();
  });

  test('counts a pattern in characters: 200 emoji are kept, 201 are refused', async ({
    page,
  }) => {
    await standInSettings(page);
    await page.goto('/settings.html#behaviour');
    const emoji = '\u{1F600}';
    await addPattern(page, emoji.repeat(201));
    await expect(entries(page)).toHaveCount(0);
    await expect(section(page).locator('#ignored-titles-error')).toContainText(
      'at most 200',
    );
    await addPattern(page, emoji.repeat(200));
    await expect(entries(page)).toHaveCount(1);
    await expect(section(page).locator('#ignored-titles-error')).toBeHidden();
  });

  test('Enter in the field adds the pattern and does not save the form', async ({
    page,
  }) => {
    const server = await standInSettings(page);
    await page.goto('/settings.html#behaviour');
    await pattern(page).fill('^Nightly');
    await pattern(page).press('Enter');
    await expect(entries(page)).toHaveCount(1);
    expect(server.puts).toEqual([]);
  });

  test('removes a pattern, and the empty state returns', async ({ page }) => {
    const server = await standInSettings(page, {
      ignoredTitles: ['^Weekly report', '^Nightly'],
    });
    await page.goto('/settings.html#behaviour');
    await expect(entries(page)).toHaveCount(2);
    await page.getByRole('button', { name: 'Remove ^Weekly report' }).click();
    await expect(entries(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Remove ^Nightly' }).click();
    await expect(section(page).locator('#ignored-titles-empty')).toBeVisible();
    await save(page).click();
    await expect(page.locator('#status')).toHaveText('Saved.');
    expect(server.stored.ignoredTitles).toEqual([]);
  });

  test('ignores a blank and a repeat that differs only by case', async ({
    page,
  }) => {
    await standInSettings(page);
    await page.goto('/settings.html#behaviour');
    await addPattern(page, '   ');
    await addPattern(page, '^Weekly');
    await addPattern(page, '^weekly');
    await expect(entries(page)).toHaveCount(1);
    await expect(
      pattern(page).getAttribute('aria-invalid'),
    ).resolves.toBeNull();
  });

  test('stops at 20 entries and says so', async ({ page }) => {
    await standInSettings(page, {
      ignoredTitles: Array.from({ length: 20 }, (_, i) => `^Report ${i}`),
    });
    await page.goto('/settings.html#behaviour');
    await expect(entries(page)).toHaveCount(20);
    await addPattern(page, 'one more');
    await expect(entries(page)).toHaveCount(20);
    const error = section(page).locator('#ignored-titles-error');
    await expect(error).toContainText('at most 20');
    await expect(pattern(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(pattern(page)).toHaveAttribute(
      'aria-describedby',
      /ignored-titles-error/,
    );
  });

  test('shows the Dependency Dashboard checkbox state and saves it', async ({
    page,
  }) => {
    const server = await standInSettings(page);
    await page.goto('/settings.html#behaviour');
    await hideBox(page).check();
    await save(page).click();
    await expect(page.locator('#status')).toHaveText('Saved.');
    expect(server.stored.hideDependencyDashboard).toBe(true);
    await page.reload();
    await expect(hideBox(page)).toBeChecked();
  });

  test('a save of another setting sends both issue settings unchanged', async ({
    page,
  }) => {
    const server = await standInSettings(page, {
      hideDependencyDashboard: true,
      ignoredTitles: ['^Weekly report'],
    });
    await page.goto('/settings.html#behaviour');
    await expect(entries(page)).toHaveCount(1);
    await page.getByLabel('Renovate rebase label').fill('refresh');
    await save(page).click();
    await expect(page.locator('#status')).toHaveText('Saved.');
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]).toMatchObject({
      hideDependencyDashboard: true,
      ignoredTitles: ['^Weekly report'],
    });
    expect(server.stored.ignoredTitles).toEqual(['^Weekly report']);
  });

  test('changing the theme does not touch the issue settings', async ({
    page,
  }) => {
    const server = await standInSettings(page, {
      ignoredTitles: ['^Weekly report'],
    });
    await page.goto('/settings.html#display');
    await page.locator('.theme-segmented label', { hasText: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(server.puts).toEqual([]);
    expect(server.stored.ignoredTitles).toEqual(['^Weekly report']);
  });

  test('shows the server refusing a pattern next to the field, and saves nothing', async ({
    page,
  }) => {
    const server = await standInSettings(page);
    await page.goto('/settings.html#behaviour');
    await addPattern(page, '(');
    await save(page).click();
    const error = section(page).locator('#ignored-titles-error');
    await expect(error).toContainText('missing closing )');
    await expect(error).toContainText('ignoredTitles entry 1 ("(")');
    await expect(pattern(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(pattern(page)).toHaveAttribute(
      'aria-describedby',
      /ignored-titles-error/,
    );
    await expect(pattern(page)).toBeFocused();
    await expect(page.locator('#status')).not.toHaveText('Saved.');
    expect(server.stored.ignoredTitles).toEqual([]);
    // Removing the bad entry clears the message.
    await page.getByRole('button', { name: 'Remove (' }).click();
    await expect(error).toBeHidden();
    await expect(pattern(page)).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('fits a 360px phone with entries and an error, no sideways scroll', async ({
    page,
  }) => {
    await standInSettings(page, {
      ignoredTitles: ['^Weekly report', `^${'a'.repeat(190)}`],
    });
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/settings.html#behaviour');
    await expect(entries(page)).toHaveCount(2);
    await addPattern(page, 'one');
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    // Touch targets are 44px high on a phone.
    for (const target of [
      page.getByRole('button', { name: 'Remove ^Weekly report' }),
      add(page),
      save(page),
      hideBox(page).locator('xpath=ancestor::label'),
    ]) {
      const box = await target.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`axe, ${scheme}`, () => {
      const scan = (page: Page) =>
        new AxeBuilder({ page })
          .include('#issue-settings')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();

      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
      });

      test('empty', async ({ page }) => {
        await standInSettings(page);
        await page.goto('/settings.html#behaviour');
        await expect(
          section(page).getByRole('heading', { name: 'Issues' }),
        ).toBeVisible();
        await expect(hideBox(page)).toBeVisible();
        await expect(pattern(page)).toBeVisible();
        await expect(add(page)).toBeVisible();
        await expect(
          section(page).locator('#ignored-titles-empty'),
        ).toBeVisible();
        expect((await scan(page)).violations).toEqual([]);
      });

      test('with entries', async ({ page }) => {
        await standInSettings(page, {
          hideDependencyDashboard: true,
          ignoredTitles: ['^Weekly report', '^Nightly'],
        });
        await page.goto('/settings.html#behaviour');
        await expect(
          section(page).getByRole('heading', { name: 'Issues' }),
        ).toBeVisible();
        await expect(hideBox(page)).toBeChecked();
        await expect(entries(page)).toHaveCount(2);
        await expect(
          page.getByRole('button', { name: 'Remove ^Nightly' }),
        ).toBeVisible();
        expect((await scan(page)).violations).toEqual([]);
      });

      test('with an error', async ({ page }) => {
        await standInSettings(page, { ignoredTitles: ['('] });
        await page.goto('/settings.html#behaviour');
        await save(page).click();
        await expect(
          section(page).locator('#ignored-titles-error'),
        ).toBeVisible();
        await expect(entries(page)).toHaveCount(1);
        await expect(pattern(page)).toHaveAttribute('aria-invalid', 'true');
        expect((await scan(page)).violations).toEqual([]);
      });
    });
  }
});
