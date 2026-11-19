import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { labelButton, labelPanel, toggleLabels } from './label-filter-helper';
import { test } from './server-fixture';

// Each option in the Label filter is drawn as the chip the rows use: the
// label's colour behind its name, with the ink the rows' contrast rule picks.
// The name stays text and the checkbox still carries the ticked state and the
// accessible name. A name that has different colours in different repos is
// drawn neutral: the filter never claims a colour that is only some repos'.
// https://github.com/alrayyes/forge-dashboard/issues/4274

const NOW = new Date().toISOString();

function pr(
  number: number,
  repo: string,
  ...labels: { name: string; color: string }[]
): Record<string, unknown> {
  return {
    forge: 'github',
    repo,
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'alice',
    draft: false,
    ci: 'success',
    labels,
    createdAt: NOW,
    updatedAt: NOW,
    mergeStatus: 'mergeable',
  };
}

const RED = { name: 'bug', color: 'd73a4a' };
const DARK = { name: 'dark', color: '0b0f14' };
// "triage" is yellow in one repo and blue in the other.
const PRS = [
  pr(1, 'acme/app', RED, DARK),
  pr(2, 'acme/app', { name: 'triage', color: 'fbca04' }),
  pr(3, 'acme/api', { name: 'triage', color: '0075ca' }),
  // A colour the forge sent that is not six hex digits.
  pr(4, 'acme/app', { name: 'odd', color: 'red' }),
];

async function open(page: Page, width?: number) {
  if (width) await page.setViewportSize({ width, height: 800 });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: NOW,
        forges: [forgeHealth('github')],
        pullRequests: PRS,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row').first()).toBeVisible();
  // On a phone the filters live in a sheet.
  if (width && width < 600)
    await page.getByRole('button', { name: /^Filters/ }).click();
  await labelButton(page).click();
  await expect(labelPanel(page)).toBeVisible();
}

const chip = (page: Page, name: string) =>
  labelPanel(page)
    .locator('.label-filter-option', {
      has: page.getByRole('checkbox', { name }),
    })
    .locator('.pick-name');

const style = (page: Page, name: string) =>
  chip(page, name).evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, ink: s.color };
  });

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe('Label filter: coloured chips', () => {
  test('an option wears its label colour with the rows ink', async ({
    page,
  }) => {
    await open(page);
    expect(await style(page, 'bug')).toEqual({
      bg: 'rgb(215, 58, 74)',
      ink: 'rgb(0, 0, 0)',
    });
    expect(await style(page, 'dark')).toEqual({
      bg: 'rgb(11, 15, 20)',
      ink: 'rgb(255, 255, 255)',
    });
  });

  test('the option matches the chip on the row', async ({ page }) => {
    await open(page);
    const row = await page
      .locator('#pr-rows > .row .label-chip', { hasText: 'bug' })
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, ink: s.color };
      });
    expect(await style(page, 'bug')).toEqual(row);
  });

  test('a malformed colour is the same neutral chip in the row and the filter', async ({
    page,
  }) => {
    await open(page);
    const row = await page
      .locator('#pr-rows > .row .label-chip', { hasText: 'odd' })
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          bg: s.backgroundColor,
          ink: s.color,
          inline: el.style.cssText,
        };
      });
    const filter = await style(page, 'odd');
    expect(row.inline).toBe('');
    expect({ bg: row.bg, ink: row.ink }).toEqual(filter);
    expect(await chip(page, 'odd').evaluate((el) => el.style.cssText)).toBe('');
  });

  test('a name with different colours in different repos is neutral', async ({
    page,
  }) => {
    await open(page);
    const triage = await style(page, 'triage');
    for (const colour of ['rgb(251, 202, 4)', 'rgb(0, 117, 202)'])
      expect(triage.bg).not.toBe(colour);
    // The page's own surface, not a label colour.
    const plain = await chip(page, 'triage').evaluate(
      (el) => el.style.backgroundColor,
    );
    expect(plain).toBe('');
    await expect(chip(page, 'triage')).toHaveClass(/pick-chip/);
  });

  test('the name stays text and the accessible name is unchanged', async ({
    page,
  }) => {
    await open(page);
    await expect(chip(page, 'bug')).toHaveText('bug');
    await expect(
      labelPanel(page).getByRole('checkbox', { name: 'bug', exact: true }),
    ).toBeVisible();
    await expect(labelButton(page)).toHaveAccessibleName(
      'Filter by label: All labels',
    );
  });

  test('ticking keeps the colour and shows a tick', async ({ page }) => {
    await open(page);
    await labelPanel(page).getByRole('checkbox', { name: 'bug' }).check();
    await expect(
      labelPanel(page).getByRole('checkbox', { name: 'bug' }),
    ).toBeChecked();
    expect((await style(page, 'bug')).bg).toBe('rgb(215, 58, 74)');
  });

  test('keyboard: a chip option takes focus and ticks with Space', async ({
    page,
  }) => {
    await open(page);
    const box = labelPanel(page).getByRole('checkbox', { name: 'bug' });
    await box.focus();
    await page.keyboard.press('Space');
    await expect(box).toBeChecked();
  });

  test('has no axe violations, light and dark', async ({ page }) => {
    await open(page);
    await axe(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await axe(page);
  });

  test('at phone width the options wrap and stay 24px tall', async ({
    page,
  }) => {
    await open(page, 360);
    const options = labelPanel(page).locator('.label-filter-option');
    for (const option of await options.all()) {
      const box = await option.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
    }
    await axe(page);
  });

  test('still filters', async ({ page }) => {
    await open(page);
    await toggleLabels(page, 'bug');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
  });
});
