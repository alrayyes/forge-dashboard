import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// The regex of each ignored title pattern is drawn in token styles (#4852).
// The server stands in with a pattern that has every token class. The text,
// the row's size and the names the buttons carry must stay as they were.

const PATTERN = '^(a|b)\\(web\\)[a-z\\]]{2,3}x+$';
const PLAIN = 'Weekly report';

async function standIn(page: Page) {
  await page.route(
    (url) => url.pathname === '/api/v1/settings',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
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
          ignoredTitles: [PATTERN, PLAIN],
        }),
      }),
  );
}

const list = (page: Page) => page.locator('#issue-settings #ignored-titles');
const code = (page: Page, index: number) =>
  list(page).locator('li').nth(index).locator('code');

// How each token class is drawn, by class name.
function drawn(page: Page) {
  return code(page, 0)
    .locator('span')
    .evaluateAll((spans) => {
      const out: Record<string, string[]> = {};
      for (const s of spans) {
        const kind = s.className.replace('rx-', '');
        const cs = getComputedStyle(s);
        out[kind] = [
          cs.color,
          cs.fontWeight,
          cs.fontStyle,
          cs.textDecorationLine,
          cs.textDecorationStyle,
        ];
      }
      return out;
    });
}

const KINDS = ['anchor', 'escape', 'group', 'class', 'quantifier', 'literal'];

test.describe('Settings: regex colours in ignored titles (#4852)', () => {
  test('the text, names and row size are unchanged', async ({ page }) => {
    await standIn(page);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/settings.html#behaviour');
      for (const [i, text] of [PATTERN, PLAIN].entries()) {
        await expect(code(page, i)).toHaveText(text);
        await expect(
          page.getByRole('button', { name: `Remove ${text}`, exact: true }),
        ).toBeVisible();
        // The same text with no spans, in the same box, has the same size.
        const sizes = await code(page, i).evaluate((el) => {
          const own = el.getBoundingClientRect();
          const clone = el.cloneNode(false) as HTMLElement;
          clone.textContent = el.textContent;
          el.after(clone);
          const plain = clone.getBoundingClientRect();
          clone.remove();
          return [own.width, own.height, plain.width, plain.height];
        });
        expect(sizes[0]).toBeCloseTo(sizes[2], 1);
        expect(sizes[1]).toBeCloseTo(sizes[3], 1);
      }
    }
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`every token class is drawn distinctly and axe passes, ${scheme}`, async ({
      page,
    }) => {
      await standIn(page);
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/settings.html#behaviour');
        await expect(code(page, 0)).toBeVisible();
        const styles = await drawn(page);
        expect(Object.keys(styles).sort()).toEqual([...KINDS].sort());
        expect(new Set(Object.values(styles).map((s) => s[0])).size).toBe(
          KINDS.length,
        );
        const results = await new AxeBuilder({ page })
          .include('#issue-settings')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      }
    });
  }

  test('with forced colours the classes still differ by text style', async ({
    page,
  }) => {
    await standIn(page);
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/settings.html#behaviour');
    await expect(code(page, 0)).toHaveText(PATTERN);
    const styles = await drawn(page);
    const shapes = Object.entries(styles)
      .filter(([kind]) => kind !== 'literal')
      .map(([, s]) => s.slice(1).join('|'));
    expect(new Set(shapes).size).toBe(KINDS.length - 1);
    expect(shapes).not.toContain(styles.literal.slice(1).join('|'));
  });
});
