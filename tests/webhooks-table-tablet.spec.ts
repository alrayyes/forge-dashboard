import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// At 820px the Webhooks table used to break "Enable auto-update" over three
// lines (hyphenated) and "Rebase bots: off" over two (#3373). The actions stay
// on one line, the Set up column folds into the Webhook cell, and the help
// text is at least 12px.

const REPOS = [
  { forge: 'github', fullName: 'alrayyes/forge-dashboard', hasWebhook: true },
  {
    forge: 'forgejo',
    fullName: 'alrayyes/a-longer-repository-name',
    hasWebhook: false,
    canManageWebhooks: false,
    webhookLockedByConnection: true,
  },
  {
    forge: 'github',
    fullName: 'alrayyes/gamma',
    hasWebhook: false,
    canManageWebhooks: true,
    autoUpdateBranch: true,
    rebaseBots: true,
  },
];

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/dashboard*', (route: Route) =>
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
  await expect(page.locator('#webhooks-rows tr')).toHaveCount(REPOS.length);
}

test.describe('webhooks table at tablet width', () => {
  test('actions sit on one line, unhyphenated, at 820px', async ({ page }) => {
    await open(page, 820);
    const bad = await page.evaluate(() =>
      [...document.querySelectorAll('#webhooks-rows td.action button')].flatMap(
        (b) => {
          const el = b as HTMLElement;
          const cs = getComputedStyle(el);
          const oneLine =
            el.getBoundingClientRect().height <
            Number.parseFloat(cs.fontSize) * 2;
          const ok = cs.whiteSpace === 'nowrap' && cs.hyphens !== 'auto';
          return ok && oneLine
            ? []
            : [`${el.textContent?.trim()} ws=${cs.whiteSpace}`];
        },
      ),
    );
    expect(bad).toEqual([]);
  });

  test('a repo without a webhook keeps its manual link in the Webhook cell, and there is no Set up column', async ({
    page,
  }) => {
    await open(page, 820);
    await expect(
      page.getByRole('columnheader', { name: 'Set up' }),
    ).toHaveCount(0);
    const row = page.locator('#webhooks-rows tr', {
      hasText: 'a-longer-repository-name',
    });
    const cell = row.locator('td[data-label="Webhook"]');
    await expect(cell).toContainText('Not yet');
    await expect(
      cell.getByRole('link', { name: /set it up manually/i }),
    ).toBeVisible();
  });

  test('on/off state is text and each control names its repo', async ({
    page,
  }) => {
    await open(page, 820);
    const row = page.locator('#webhooks-rows tr', { hasText: 'gamma' });
    await expect(
      row.getByRole('button', { name: /Rebase bots: on.*alrayyes\/gamma/ }),
    ).toContainText('Rebase bots: on');
    await expect(
      row.getByRole('button', { name: /Disable auto-update.*alrayyes\/gamma/ }),
    ).toBeVisible();
  });

  for (const width of [820, 1024]) {
    test(`no horizontal scroll and help text >= 12px at ${width}px`, async ({
      page,
    }) => {
      await open(page, width);
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        help: [...document.querySelectorAll('.webhook-locked-reason')].map(
          (e) => Number.parseFloat(getComputedStyle(e).fontSize),
        ),
      }));
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      expect(m.help.length).toBeGreaterThan(0);
      for (const px of m.help) expect(px).toBeGreaterThanOrEqual(12);
    });
  }

  test('390px stays a card layout', async ({ page }) => {
    await open(page, 390);
    const display = await page
      .locator('#webhooks-rows tr')
      .first()
      .evaluate((e) => getComputedStyle(e).display);
    expect(display).toBe('block');
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    );
    expect(fits).toBe(true);
  });

  test(`axe finds nothing at every width`, async ({ page }) => {
    for (const width of [820, 1280]) {
      await test.step(`${width}px`, async () => {
        await open(page, width);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  });
});
