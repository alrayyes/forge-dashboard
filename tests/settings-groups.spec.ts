import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// Settings is four groups, one shown at a time, the choice in the URL hash.
// https://github.com/alrayyes/forge-dashboard/issues/1680

const GROUPS = [
  {
    id: 'display',
    label: 'Display',
    cards: ['Appearance'],
    absent: ['GitHub', 'Webhooks'],
  },
  {
    id: 'connections',
    label: 'Connections',
    cards: ['GitHub', 'Forgejo'],
    absent: ['Issues', 'Appearance'],
  },
  {
    id: 'behaviour',
    label: 'Behaviour',
    cards: ['Pull request behavior', 'Issues', 'Forgejo auto-merge'],
    absent: ['GitHub', 'Webhooks'],
  },
  {
    id: 'integrations',
    label: 'Integrations and security',
    cards: ['Webhooks', 'Passkeys', 'API tokens'],
    absent: ['Issues', 'Appearance'],
  },
] as const;

const ANCHORS: Record<string, string> = {
  'issue-settings': 'behaviour',
  'forgejo-auto-merge': 'behaviour',
  webhooks: 'integrations',
  passkeys: 'integrations',
  'api-tokens': 'integrations',
};

const cardHeading = (page: Page, name: string) =>
  page.getByRole('heading', { level: 2, name, exact: true });
const groupLink = (page: Page, label: string) =>
  page
    .getByRole('navigation', { name: 'Settings groups' })
    .getByRole('link', { name: new RegExp(`^${label}( |$)`) });

test.describe('settings groups', () => {
  test('opens on Display with no hash, and an unknown hash does the same', async ({
    page,
  }) => {
    for (const url of ['/settings.html', '/settings.html#nonsense']) {
      await page.goto(url);
      await expect(cardHeading(page, 'Appearance')).toBeVisible();
      await expect(groupLink(page, 'Display')).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(cardHeading(page, 'GitHub')).toHaveCount(0);
    }
    await expect(page.locator('.settings-header h1')).toHaveText('Settings');
    await expect(page).toHaveTitle(/^Settings/);
  });

  test('each group shows its own cards and none of the others', async ({
    page,
  }) => {
    await page.goto('/settings.html');
    for (const g of GROUPS) {
      await groupLink(page, g.label).click();
      await expect(page).toHaveURL(new RegExp(`#${g.id}$`));
      for (const name of g.cards) {
        await expect(cardHeading(page, name)).toBeVisible();
      }
      for (const name of g.absent) {
        await expect(cardHeading(page, name)).toHaveCount(0);
      }
      await expect(groupLink(page, g.label)).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(
        page.locator('.settings-nav [aria-current="page"]'),
      ).toHaveCount(1);
    }
  });

  test('there is no Sharing group, and an old #sharing link opens Display', async ({
    page,
  }) => {
    await page.goto('/settings.html#sharing');
    await expect(groupLink(page, 'Display')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('link', { name: /sharing/i })).toHaveCount(0);
    await expect(cardHeading(page, 'Shared with you')).toHaveCount(0);
  });

  test('a group id in the hash opens that group on load', async ({ page }) => {
    for (const g of GROUPS) {
      await page.goto(`/settings.html#${g.id}`);
      await expect(cardHeading(page, g.cards[0])).toBeVisible();
    }
  });

  for (const [anchor, group] of Object.entries(ANCHORS)) {
    test(`/settings.html#${anchor} opens ${group} and scrolls the card into view`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 500 });
      await page.goto(`/settings.html#${anchor}`);
      const card = page.locator(`#${anchor}`);
      await expect(card).toBeVisible();
      await expect(card).toBeInViewport();
      const g = GROUPS.find((x) => x.id === group);
      await expect(groupLink(page, g?.label ?? '').first()).toHaveAttribute(
        'aria-current',
        'page',
      );
    });
  }

  test('hashchange, back and forward move between groups', async ({ page }) => {
    await page.goto('/settings.html');
    await groupLink(page, 'Connections').click();
    await expect(cardHeading(page, 'GitHub')).toBeVisible();
    await groupLink(page, 'Behaviour').click();
    await expect(cardHeading(page, 'Issues')).toBeVisible();

    await page.goBack();
    await expect(cardHeading(page, 'GitHub')).toBeVisible();
    await expect(cardHeading(page, 'Issues')).toHaveCount(0);
    await page.goForward();
    await expect(cardHeading(page, 'Issues')).toBeVisible();

    await page.evaluate(() => {
      window.location.hash = '#api-tokens';
    });
    await expect(cardHeading(page, 'API tokens')).toBeVisible();
  });

  test('the current group is marked by a bar and bold text, not only colour', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/settings.html#connections');
    const current = groupLink(page, 'Connections');
    const other = groupLink(page, 'Display');
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(other).not.toHaveAttribute('aria-current', /.*/);
    const style = (l: typeof current) =>
      l.evaluate((el) => {
        const cs = getComputedStyle(el);
        const label = getComputedStyle(el.querySelector('.label') as Element);
        return {
          bar: Number.parseFloat(cs.borderLeftWidth) > 0,
          barColour: cs.borderLeftColor,
          weight: Number(label.fontWeight),
        };
      });
    const a = await style(current);
    const b = await style(other);
    expect(a.weight).toBeGreaterThan(b.weight);
    expect(a.barColour).not.toBe(b.barColour);
  });

  test('a token help disclosure is closed by default and toggles aria-expanded', async ({
    page,
  }) => {
    await page.goto('/settings.html#connections');
    // Settings loaded means the page has hydrated, so clicks reach handlers.
    await expect(page.locator('#save-connections-button')).toBeEnabled();
    const toggles = page.getByRole('button', {
      name: 'What does this token need?',
    });
    await expect(toggles).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const t = toggles.nth(i);
      const panelId = await t.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      const panel = page.locator(`#${panelId}`);
      await expect(t).toHaveAttribute('aria-expanded', 'false');
      await expect(panel).toBeHidden();
      await t.click();
      await expect(t).toHaveAttribute('aria-expanded', 'true');
      await expect(panel).toBeVisible();
      await t.click();
      await expect(t).toHaveAttribute('aria-expanded', 'false');
      await expect(panel).toBeHidden();
    }
    await page.goto('/settings.html#integrations');
    await expect(page.locator('#save-connections-button')).toBeEnabled();
    const how = page.getByRole('button', {
      name: 'How do I add these to a repo?',
    });
    await expect(how).toHaveAttribute('aria-expanded', 'false');
    await how.click();
    await expect(page.locator('#webhook-howto')).toBeVisible();
  });

  test('unsaved edits survive switching groups', async ({ page }) => {
    await page.goto('/settings.html#connections');
    await page.locator('#github-username').fill('typed-but-unsaved');
    await groupLink(page, 'Display').click();
    await expect(page.locator('#github-username')).toBeHidden();
    await groupLink(page, 'Connections').click();
    await expect(page.locator('#github-username')).toHaveValue(
      'typed-but-unsaved',
    );
  });

  test('keyboard only: Tab reaches the group links and Enter opens a group', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/settings.html');
    // Nothing takes focus on load.
    expect(
      await page.evaluate(() => document.activeElement === document.body),
    ).toBe(true);
    const link = groupLink(page, 'Behaviour');
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await link.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(cardHeading(page, 'Issues')).toBeVisible();
    // No trap: Tab moves on into the cards.
    await page.keyboard.press('Tab');
    await expect(link).not.toBeFocused();
  });

  test('360px: all four groups are reachable, 44px high, with no sideways scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/settings.html');
    for (const g of GROUPS) {
      const link = groupLink(page, g.label);
      await expect(link).toBeInViewport({ ratio: 1 });
      const box = await link.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
    await groupLink(page, 'Integrations and security').click();
    await expect(cardHeading(page, 'Passkeys')).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test.describe('per-card saves still work', () => {
    test('Display: choosing a theme saves it', async ({ page }) => {
      await page.goto('/settings.html#display');
      await page.getByLabel('Dark', { exact: true }).check();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    });

    test('Connections and Behaviour: the one Save button saves both groups', async ({
      page,
    }) => {
      await page.goto('/settings.html#connections');
      await page.locator('#github-username').fill('groups-user');
      await groupLink(page, 'Behaviour').click();
      await page.locator('#renovate-rebase-label').fill('go');
      await page.locator('#save-button').click();
      await expect(page.locator('#status')).toContainText(/saved/i);
      await page.reload();
      await expect(page.locator('#renovate-rebase-label')).toHaveValue('go');
      await groupLink(page, 'Connections').click();
      await expect(page.locator('#github-username')).toHaveValue('groups-user');
    });

    test('Connections: its own Save button saves and says so', async ({
      page,
    }) => {
      await page.goto('/settings.html#connections');
      await page.locator('#github-username').fill('conn-user');
      await page.locator('#save-connections-button').click();
      await expect(page.locator('#connections-status')).toHaveText('Saved.');
    });

    test('Integrations and security: generating an API token works', async ({
      page,
    }) => {
      await page.goto('/settings.html#api-tokens');
      await page.locator('#token-label').fill('groups-token');
      await page.getByRole('button', { name: /generate|create/i }).click();
      await expect(page.locator('#token-reveal-field')).toBeVisible();
    });
  });

  test.describe('a refused save brings the refused field into view', () => {
    test('a server refusal names a field in another group: that group opens and the field is focused', async ({
      page,
    }) => {
      await page.goto('/settings.html#connections');
      await expect(page.locator('#save-connections-button')).toBeEnabled();
      await page.locator('#forgejo-username').fill('octocat-forgejo');
      await groupLink(page, 'Behaviour').click();
      await expect(page.locator('#forgejo-username')).toBeHidden();
      const historyBefore = await page.evaluate(() => history.length);
      await page.locator('#save-button').click();

      await expect(groupLink(page, 'Connections')).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page.locator('#forgejo-url')).toBeFocused();
      await expect(page.locator('#connections-status')).toContainText(
        /forgejoUrl/,
      );
      await expect(page.locator('#connections-status')).toBeVisible();
      expect(new URL(page.url()).hash).toBe('#connections');
      // The switch replaces the current entry: no history entry of its own.
      expect(await page.evaluate(() => history.length)).toBe(historyBefore);
    });

    test('a bad pattern left in the box, saved from another group: Behaviour opens with the box focused and its error shown', async ({
      page,
    }) => {
      await page.goto('/settings.html#behaviour');
      await expect(page.locator('#save-connections-button')).toBeEnabled();
      await page.locator('#ignored-pattern').fill('(');
      await groupLink(page, 'Connections').click();
      await expect(page.locator('#ignored-pattern')).toBeHidden();
      await page.locator('#save-connections-button').click();

      await expect(groupLink(page, 'Behaviour')).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page.locator('#ignored-pattern')).toBeFocused();
      await expect(page.locator('#ignored-titles-error')).toBeVisible();
      await expect(page.locator('#status')).toBeVisible();
    });
  });

  test.describe('a save says when it included edits from another group', () => {
    test('Connections Save names Behaviour edits', async ({ page }) => {
      await page.goto('/settings.html#behaviour');
      await expect(page.locator('#save-connections-button')).toBeEnabled();
      await page.locator('#renovate-rebase-label').fill('from-behaviour');
      await groupLink(page, 'Connections').click();
      await page.locator('#save-connections-button').click();
      await expect(page.locator('#connections-status')).toHaveText(
        'Saved, including your changes in Behaviour.',
      );
    });

    test('Enter in a field saves that group: only its own edit gives a plain Saved.', async ({
      page,
    }) => {
      await page.goto('/settings.html#behaviour');
      await expect(page.locator('#save-connections-button')).toBeEnabled();
      await page.locator('#renovate-rebase-label').fill('enter-saves');
      await page.locator('#renovate-rebase-label').press('Enter');
      await expect(page.locator('#status')).toHaveText('Saved.');

      await groupLink(page, 'Connections').click();
      await page.locator('#github-username').fill('enter-user');
      await page.locator('#github-username').press('Enter');
      await expect(page.locator('#connections-status')).toHaveText('Saved.');
    });

    test('Behaviour Save names Connections edits, and a plain save just says Saved.', async ({
      page,
    }) => {
      await page.goto('/settings.html#connections');
      await expect(page.locator('#save-connections-button')).toBeEnabled();
      await page.locator('#github-username').fill('from-connections');
      await groupLink(page, 'Behaviour').click();
      await page.locator('#save-button').click();
      await expect(page.locator('#status')).toHaveText(
        'Saved, including your changes in Connections.',
      );
      await page.locator('#renovate-rebase-label').fill('own-edit');
      await page.locator('#save-button').click();
      await expect(page.locator('#status')).toHaveText('Saved.');
    });
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 360]) {
      test(`axe passes in every group, ${scheme}, ${width}px`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
        for (const g of GROUPS) {
          await page.goto(`/settings.html#${g.id}`);
          await expect(cardHeading(page, g.cards[0])).toBeVisible();
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .analyze();
          // Help opened as well: its text and chevron are part of the page.
          const toggles = page.locator('.disclosure-toggle:visible');
          for (let i = 0; i < (await toggles.count()); i++) {
            await toggles.nth(i).click();
          }
          const opened = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .analyze();
          expect(
            opened.violations,
            `${g.id} (help open): ${opened.violations.map((v) => v.id).join(', ')}`,
          ).toEqual([]);
          expect(
            results.violations,
            `${g.id}: ${results.violations.map((v) => v.id).join(', ')}`,
          ).toEqual([]);
        }
      });
    }
  }
});
