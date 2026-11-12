import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// "Not yet" in the Webhooks table is the state that needs action, so it must
// not read as the quiet one (#3318): at least as heavy as "Confirmed", not
// the dimmest text on the row, 4.5:1 or more, with a decorative icon.

const REPOS = [
  { forge: 'github', fullName: 'alrayyes/done', hasWebhook: true },
  {
    forge: 'github',
    fullName: 'alrayyes/todo',
    hasWebhook: false,
    canManageWebhooks: true,
  },
];

async function open(page: Page, width: number, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme });
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

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [390, 820, 1280]) {
    test.describe(`${scheme} ${width}px`, () => {
      test('Not yet is as prominent as Confirmed and readable', async ({
        page,
      }) => {
        await open(page, width, scheme);
        const m = await page.evaluate(() => {
          const lum = (c: string) => {
            const v = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
            const [r, g, b] = v.map((x) => {
              const s = x / 255;
              return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const contrast = (a: string, b: string) => {
            const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
            return (hi + 0.05) / (lo + 0.05);
          };
          const word = (txt: string) => {
            const rows = [...document.querySelectorAll('#webhooks-rows tr')];
            const row = rows.find((r) => r.textContent?.includes(txt));
            const cell = row?.querySelector('td[data-label="Webhook"]');
            const el = cell?.querySelector('.status-word') as HTMLElement;
            const cs = getComputedStyle(el);
            const bg = getComputedStyle(cell as Element).backgroundColor;
            return {
              weight: Number(cs.fontWeight),
              color: cs.color,
              ink3: getComputedStyle(document.documentElement)
                .getPropertyValue('--ink-3')
                .trim(),
              contrast: contrast(
                cs.color,
                bg === 'rgba(0, 0, 0, 0)'
                  ? getComputedStyle(document.body).backgroundColor
                  : bg,
              ),
              icon: el.querySelector('[aria-hidden="true"]') !== null,
              text: el.textContent?.replace(/\s+/g, ' ').trim(),
            };
          };
          return { done: word('done'), todo: word('todo') };
        });
        expect(m.todo.weight).toBeGreaterThanOrEqual(m.done.weight);
        expect(m.todo.contrast).toBeGreaterThanOrEqual(4.5);
        expect(m.todo.contrast).toBeGreaterThanOrEqual(m.done.contrast - 1);
        expect(m.todo.icon).toBe(true);
        expect(m.todo.text).toContain('Not yet');
        expect(m.todo.weight).toBeGreaterThan(400);
      });

      test('nothing overflows and axe is clean', async ({ page }) => {
        await open(page, width, scheme);
        const fits = await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        );
        expect(fits).toBe(true);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    });
  }
}
