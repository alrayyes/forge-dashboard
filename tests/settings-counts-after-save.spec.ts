import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// A save can come back before the server knows any count: the first-ever save,
// or one before the first refresh finished, answers every ignoredTitleCounts
// entry null. The page then says "Counting…" and re-reads the saved settings
// a few times, two seconds apart, taking only the counts. Mocked GET and PUT;
// the page clock stands in for the waiting.
// https://github.com/alrayyes/forge-dashboard/issues/1676

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `settings-counting-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'Settings Counting',
  );
}

async function standIn(page: Page, titles: string[]) {
  const state = {
    titles,
    // What a GET answers for the saved list; null entries until set.
    counts: null as Record<string, number | null> | null,
    gets: 0,
    puts: 0,
  };
  const body = (counts: (number | null)[]) => ({
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
    ignoredTitleCounts: counts,
  });
  await page.route(
    (url) => url.pathname === '/api/settings',
    (route: Route) => {
      const request = route.request();
      if (request.method() === 'PUT') {
        state.puts++;
        state.titles = (
          request.postDataJSON() as { ignoredTitles: string[] }
        ).ignoredTitles;
        // The save is counted against the snapshot from before it.
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body(state.titles.map(() => null))),
        });
      }
      state.gets++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          body(state.titles.map((t) => state.counts?.[t] ?? null)),
        ),
      });
    },
  );
  return state;
}

const section = (page: Page) => page.locator('#issue-settings');
const rows = (page: Page) => section(page).locator('#ignored-titles > li');
const row = (page: Page, text: string) =>
  rows(page).filter({ has: page.locator('code', { hasText: text }) });
const remove = (page: Page, text: string) =>
  page.getByRole('button', { name: `Remove ${text}` });
const save = (page: Page) => page.locator('#save-button');

async function addPattern(page: Page, text: string) {
  await section(page).getByRole('textbox', { name: 'Pattern' }).fill(text);
  await section(page).getByRole('button', { name: 'Add' }).click();
}

// Each re-read is scheduled once the one before it has been answered, so one
// big jump of the clock fires only the first. Step it until the Nth GET.
async function untilGets(page: Page, server: { gets: number }, total: number) {
  await expect
    .poll(async () => {
      await page.clock.runFor(2000);
      return server.gets;
    })
    .toBe(total);
}

async function firstSave(page: Page, pattern: string) {
  await page.clock.install();
  await page.goto('/settings.html');
  await expect(
    section(page).getByRole('heading', { name: 'Issues' }),
  ).toBeVisible();
  await addPattern(page, pattern);
  await save(page).click();
  await expect(page.locator('#status')).toHaveText('Saved.');
}

test.describe('Settings: counting after the first save (#1676)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('says Counting… then the number, without a reload', async ({ page }) => {
    const server = await standIn(page, []);
    await firstSave(page, '^Weekly');
    await expect(row(page, '^Weekly')).toContainText('Counting…');
    await expect(remove(page, '^Weekly')).toHaveAccessibleDescription(
      'Counting…',
    );
    await expect(
      page.locator('[role="status"]:has-text("Counting")'),
    ).toHaveCount(0);
    await page.clock.runFor(2000);
    await expect(row(page, '^Weekly')).toContainText('Counting…');
    server.counts = { '^Weekly': 2 };
    await page.clock.runFor(2000);
    await expect(row(page, '^Weekly')).toContainText('hides 2 issues');
    await expect(row(page, '^Weekly')).not.toContainText('Counting');
    await expect(remove(page, '^Weekly')).toHaveAccessibleDescription(
      'hides 2 issues',
    );
    // It stopped at the first answer.
    const gets = server.gets;
    await page.clock.runFor(10000);
    expect(server.gets).toBe(gets);
  });

  test('a forge that never answers ends with nothing shown', async ({
    page,
  }) => {
    const server = await standIn(page, []);
    await firstSave(page, '^Weekly');
    await expect(row(page, '^Weekly')).toContainText('Counting…');
    const before = server.gets;
    await untilGets(page, server, before + 5);
    await expect(section(page)).not.toContainText('Counting');
    await expect(section(page)).not.toContainText('hides');
    await expect(section(page).locator('.pattern-count')).toHaveCount(0);
    expect(server.gets - before).toBe(5);
    await page.clock.runFor(2000);
    await page.clock.runFor(2000);
    await page.clock.runFor(2000);
    expect(server.gets - before).toBe(5);
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  });

  test('editing the list stops the retries and keeps the form', async ({
    page,
  }) => {
    const server = await standIn(page, []);
    await firstSave(page, '^Weekly');
    await expect(row(page, '^Weekly')).toContainText('Counting…');
    await section(page).getByRole('textbox', { name: 'Pattern' }).fill('^half');
    await addPattern(page, '^added');
    await section(page)
      .getByRole('textbox', { name: 'Pattern' })
      .fill('^typing');
    const before = server.gets;
    server.counts = { '^Weekly': 7 };
    await page.clock.runFor(2000);
    await page.clock.runFor(2000);
    await page.clock.runFor(2000);
    expect(server.gets).toBe(before);
    await expect(section(page)).not.toContainText('Counting');
    await expect(row(page, '^added')).toContainText('Counted after you save');
    await expect(rows(page)).toHaveCount(2);
    await expect(
      section(page).getByRole('textbox', { name: 'Pattern' }),
    ).toHaveValue('^typing');
  });

  test('a later GET never clobbers edits made while it was waiting', async ({
    page,
  }) => {
    const server = await standIn(page, []);
    await firstSave(page, '^Weekly');
    server.counts = { '^Weekly': 3 };
    // Edit a text field, not the list: the retries go on and take only counts.
    const label = page.locator('input[name="renovateRebaseLabel"]');
    await label.fill('mine');
    await page.clock.runFor(2000);
    await expect(row(page, '^Weekly')).toContainText('hides 3 issues');
    await expect(rows(page)).toHaveCount(1);
    await expect(label).toHaveValue('mine');
  });

  test('another save stops the retries and starts its own', async ({
    page,
  }) => {
    const server = await standIn(page, []);
    await firstSave(page, '^Weekly');
    await addPattern(page, '^second');
    await save(page).click();
    await expect(page.locator('#status')).toHaveText('Saved.');
    await expect(row(page, '^second')).toContainText('Counting…');
    const before = server.gets;
    await untilGets(page, server, before + 5);
    await page.clock.runFor(2000);
    await page.clock.runFor(2000);
    // One run of five, not two overlapping runs.
    expect(server.gets - before).toBe(5);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe with Counting… shown at 360px, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 360, height: 780 });
      await standIn(page, []);
      await firstSave(page, `^${'a'.repeat(150)}`);
      await expect(row(page, '^aaaa')).toContainText('Counting…');
      const widths = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(widths.scroll).toBeLessThanOrEqual(widths.client);
      const results = await new AxeBuilder({ page })
        .include('#issue-settings')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
