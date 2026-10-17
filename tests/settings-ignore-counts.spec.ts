import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// How many open issues each ignored title pattern hides, beside the pattern in
// Settings. The server owns the matching and sends ignoredTitleCounts in the
// order of ignoredTitles, on GET and on the PUT response. This spec stands in
// for both, shaped like api/openapi.yaml. The server half is a separate pull
// request.
// https://github.com/alrayyes/forge-dashboard/issues/1676

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `settings-counts-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Settings Counts');
}

interface Options {
  ignoredTitles: string[];
  // What each pattern "matches" on the stand-in server; unlisted means 2.
  matches?: Record<string, number | null>;
  // False leaves the field out, as a server that does not send it yet.
  emit?: boolean;
}

async function standInSettings(page: Page, options: Options) {
  const state = {
    titles: options.ignoredTitles,
    matches: options.matches ?? {},
    emit: options.emit ?? true,
    gets: 0,
    puts: 0,
    // Holds the PUT response until released, to see the state in between.
    hold: null as Promise<void> | null,
  };
  const body = () => ({
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
    hideDependencyDashboard: false,
    ignoredTitles: state.titles,
    ...(state.emit
      ? {
          ignoredTitleCounts: state.titles.map((t) =>
            t in state.matches ? state.matches[t] : 2,
          ),
        }
      : {}),
  });
  await page.route(
    (url) => url.pathname === '/api/settings',
    async (route: Route) => {
      const request = route.request();
      if (request.method() === 'PUT') {
        state.puts++;
        state.titles = (
          request.postDataJSON() as { ignoredTitles: string[] }
        ).ignoredTitles;
        if (state.hold) await state.hold;
      } else state.gets++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body()),
      });
    },
  );
  return state;
}

const section = (page: Page) => page.locator('#issue-settings');
const rows = (page: Page) => section(page).locator('#ignored-titles > li');
const row = (page: Page, text: string) =>
  rows(page).filter({ has: page.locator('code', { hasText: text }) });
const chips = (page: Page) => section(page).locator('.pattern-count');
const remove = (page: Page, text: string) =>
  page.getByRole('button', { name: `Remove ${text}` });
const save = (page: Page) => page.locator('#save-button');

async function addPattern(page: Page, text: string) {
  await section(page).getByRole('textbox', { name: 'Pattern' }).fill(text);
  await section(page).getByRole('button', { name: 'Add' }).click();
}

test.describe('Settings: ignored title counts (#1676)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('says how many issues each pattern hides, in words', async ({
    page,
  }) => {
    await standInSettings(page, {
      ignoredTitles: ['^three', '^one', '^zero'],
      matches: { '^three': 3, '^one': 1, '^zero': 0 },
    });
    await page.goto('/settings.html');
    await expect(rows(page)).toHaveCount(3);
    await expect(row(page, '^three')).toContainText('hides 3 issues');
    await expect(row(page, '^one')).toContainText('hides 1 issue');
    await expect(row(page, '^one')).not.toContainText('hides 1 issues');
    await expect(row(page, '^zero')).toContainText('hides no issues');
    await expect(section(page)).not.toContainText('hides 0');
    // The count is read with the pattern, not a lone floating span.
    await expect(remove(page, '^three')).toHaveAccessibleDescription(
      'hides 3 issues',
    );
    await expect(remove(page, '^one')).toHaveAccessibleDescription(
      'hides 1 issue',
    );
    await expect(remove(page, '^zero')).toHaveAccessibleDescription(
      'hides no issues',
    );
  });

  test('an issue two patterns match counts for both', async ({ page }) => {
    await standInSettings(page, {
      ignoredTitles: ['^Weekly', 'report$'],
      matches: { '^Weekly': 1, report$: 1 },
    });
    await page.goto('/settings.html');
    await expect(row(page, '^Weekly')).toContainText('hides 1 issue');
    await expect(row(page, 'report$')).toContainText('hides 1 issue');
  });

  test('an unknown count shows nothing, never a 0', async ({ page }) => {
    await standInSettings(page, {
      ignoredTitles: ['^known', '^unknown'],
      matches: { '^known': 4, '^unknown': null },
    });
    await page.goto('/settings.html');
    await expect(row(page, '^known')).toContainText('hides 4 issues');
    await expect(row(page, '^unknown')).not.toContainText('hides');
    await expect(chips(page)).toHaveCount(1);
    await expect(remove(page, '^unknown')).not.toHaveAccessibleDescription(
      /hides/,
    );
  });

  test('a response without the field shows no counts and still saves', async ({
    page,
  }) => {
    const server = await standInSettings(page, {
      ignoredTitles: ['^old'],
      emit: false,
    });
    await page.goto('/settings.html');
    await expect(rows(page)).toHaveCount(1);
    await expect(chips(page)).toHaveCount(0);
    await addPattern(page, '^new');
    await expect(rows(page)).toHaveCount(2);
    await expect(section(page)).not.toContainText('Counted after you save');
    await save(page).click();
    await expect(page.locator('#status')).toHaveText('Saved.');
    expect(server.puts).toBe(1);
    await expect(chips(page)).toHaveCount(0);
    await expect(section(page)).not.toContainText('hides');
  });

  test('a new pattern is counted after the save, from the PUT response', async ({
    page,
  }) => {
    const server = await standInSettings(page, {
      ignoredTitles: ['^three'],
      matches: { '^three': 3, '^fresh': 5 },
    });
    await page.goto('/settings.html');
    await expect(row(page, '^three')).toContainText('hides 3 issues');
    const getsAfterLoad = server.gets;

    let release: () => void = () => {};
    server.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await addPattern(page, '^fresh');
    await expect(row(page, '^fresh')).toContainText('Counted after you save');
    await expect(row(page, '^fresh')).not.toContainText('hides');
    await expect(remove(page, '^fresh')).toHaveAccessibleDescription(
      'Counted after you save',
    );
    await expect(row(page, '^three')).toContainText('hides 3 issues');

    await save(page).click();
    // Still waiting for the server: the pattern is still not counted.
    await expect(save(page)).toBeDisabled();
    await expect(row(page, '^fresh')).toContainText('Counted after you save');
    release();
    await expect(page.locator('#status')).toHaveText('Saved.');
    await expect(row(page, '^fresh')).toContainText('hides 5 issues');
    await expect(row(page, '^fresh')).not.toContainText('Counted after');
    await expect(row(page, '^three')).toContainText('hides 3 issues');
    // The counts came with the PUT: no second GET.
    expect(server.gets).toBe(getsAfterLoad);
  });

  test('removing a pattern and saving updates the counts without a reload', async ({
    page,
  }) => {
    const server = await standInSettings(page, {
      ignoredTitles: ['^a', '^b'],
      matches: { '^a': 2, '^b': 1 },
    });
    await page.goto('/settings.html');
    await expect(row(page, '^a')).toContainText('hides 2 issues');
    await remove(page, '^a').click();
    await expect(rows(page)).toHaveCount(1);
    // The remaining pattern keeps its last known count while unsaved.
    await expect(row(page, '^b')).toContainText('hides 1 issue');
    server.matches['^b'] = 0;
    await save(page).click();
    await expect(page.locator('#status')).toHaveText('Saved.');
    await expect(row(page, '^b')).toContainText('hides no issues');
    await expect(chips(page)).toHaveCount(1);
  });

  test('fits a 360px phone with the count wrapped under the pattern', async ({
    page,
  }) => {
    await standInSettings(page, {
      ignoredTitles: [`^${'a'.repeat(150)}`, '^short'],
      matches: { [`^${'a'.repeat(150)}`]: 12, '^short': 1 },
    });
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/settings.html');
    await expect(chips(page)).toHaveCount(2);
    await expect(chips(page).first()).toBeVisible();
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    const long = row(page, '^aaaa');
    const code = await long.locator('code').boundingBox();
    const chip = await long.locator('.pattern-count').boundingBox();
    expect((chip?.y ?? 0) + 1).toBeGreaterThanOrEqual(
      (code?.y ?? 0) + (code?.height ?? 0),
    );
    const button = await remove(page, '^aaaa').boundingBox();
    expect(button?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe with counts and a pending pattern, ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await standInSettings(page, {
        ignoredTitles: ['^three', '^zero'],
        matches: { '^three': 3, '^zero': 0 },
      });
      await page.setViewportSize({ width: 360, height: 780 });
      await page.goto('/settings.html');
      await expect(
        section(page).getByRole('heading', { name: 'Issues' }),
      ).toBeVisible();
      await addPattern(page, '^pending');
      await expect(row(page, '^three')).toContainText('hides 3 issues');
      await expect(row(page, '^zero')).toContainText('hides no issues');
      await expect(row(page, '^pending')).toContainText(
        'Counted after you save',
      );
      const results = await new AxeBuilder({ page })
        .include('#issue-settings')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
