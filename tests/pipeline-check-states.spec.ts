import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// Mocks /api/dashboard and the checks route and writes nothing per user, so it
// starts from the shared session (#1379).
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const STATES = [
  { state: 'success', label: 'Passed' },
  { state: 'failure', label: 'Failed' },
  { state: 'timed_out', label: 'Timed out' },
  { state: 'running', label: 'Running' },
  { state: 'queued', label: 'Queued' },
  { state: 'skipped', label: 'Skipped' },
  { state: 'cancelled', label: 'Cancelled' },
];

async function open(page: Page) {
  const now = new Date().toISOString();
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: now,
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [
          {
            forge: 'github',
            repo: 'alrayyes/forge-dashboard',
            number: 42,
            title: 'Add structured logging',
            url: 'https://example.com/42',
            author: 'ryankes',
            draft: false,
            ci: 'failure',
            labels: [],
            createdAt: now,
            updatedAt: now,
            mergeStatus: 'mergeable',
            behind: false,
          },
        ],
        issues: [],
      }),
    }),
  );
  await page.route('**/api/pull-requests/checks*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        checks: STATES.map((s) => ({
          name: `check-${s.state}`,
          state: s.state,
          url: '',
          required: true,
        })),
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: 'Open pipeline' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
  await expect(dialog.locator('.pipeline-check')).toHaveCount(STATES.length);
  return dialog;
}

function status(dialog: ReturnType<Page['locator']>, state: string) {
  return dialog.locator(`.pipeline-check-status.${state}`);
}

// Relative luminance contrast of two computed rgb() colours.
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
      const s = Number(v) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test.describe('pipeline check states (#1473)', () => {
  test('each state has its own glyph and label', async ({ page }) => {
    const dialog = await open(page);
    const glyphs = new Map<string, string>();
    for (const { state, label } of STATES) {
      const pill = status(dialog, state);
      await expect(pill).toContainText(label);
      const glyph = pill.locator('svg:visible');
      await expect(glyph).toHaveCount(1);
      await expect(glyph).toHaveAttribute('aria-hidden', 'true');
      glyphs.set(state, await glyph.innerHTML());
    }
    // Failed and timed out share the cross; every other state differs.
    expect(glyphs.get('failure')).toBe(glyphs.get('timed_out'));
    glyphs.delete('timed_out');
    expect(new Set(glyphs.values()).size).toBe(glyphs.size);
  });

  test('queued is not amber and running is', async ({ page }) => {
    const dialog = await open(page);
    const color = (state: string) =>
      status(dialog, state).evaluate((el) => getComputedStyle(el).color);
    expect(await color('queued')).not.toBe(await color('running'));
    expect(await color('queued')).not.toBe(await color('skipped'));
    const root = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--warning'),
    );
    expect(root.trim()).not.toBe('');
    const running = await color('running');
    const warning = await page.evaluate(() => {
      const p = document.createElement('i');
      p.style.color = 'var(--warning)';
      document.body.appendChild(p);
      const c = getComputedStyle(p).color;
      p.remove();
      return c;
    });
    expect(running).toBe(warning);
  });

  test('running shows a still clock under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const dialog = await open(page);
    const glyph = status(dialog, 'running').locator('svg:visible');
    await expect(glyph).toHaveCount(1);
    await expect(glyph).toHaveAttribute('data-glyph', 'clock');
    const anim = await glyph.evaluate(
      (el) => getComputedStyle(el).animationName,
    );
    expect(anim).toBe('none');
  });

  test('running spins an arc otherwise', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const dialog = await open(page);
    const glyph = status(dialog, 'running').locator('svg:visible');
    await expect(glyph).toHaveAttribute('data-glyph', 'arc');
    const anim = await glyph.evaluate(
      (el) => getComputedStyle(el).animationName,
    );
    expect(anim).not.toBe('none');
  });

  test('a failed required check keeps its Blocking badge', async ({ page }) => {
    const dialog = await open(page);
    await expect(dialog.getByText('Blocking')).toHaveCount(2);
  });

  for (const theme of ['light', 'dark']) {
    test(`has no axe-core violations and clears contrast, ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const dialog = await open(page);
      // The shared user's saved theme wins over a cookie on load, so set the
      // attribute the theme module itself sets, once the page has settled.
      await page.evaluate(
        (t) => document.documentElement.setAttribute('data-theme', t),
        theme,
      );
      expect(
        (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations,
      ).toEqual([]);

      // Axe skips svg glyphs: hold every glyph to 3:1 (1.4.11) and every
      // label to 4.5:1 (1.4.3) against its own pill, skipped included.
      for (const { state } of STATES) {
        const pill = status(dialog, state);
        const m = await pill.evaluate((el) => {
          const g = [...el.querySelectorAll('svg')].find(
            (n) => getComputedStyle(n).display !== 'none',
          ) as Element;
          return {
            bg: (() => {
              // Skipped has no fill: use what actually sits behind it.
              for (let n: Element | null = el; n; n = n.parentElement) {
                const c = getComputedStyle(n).backgroundColor;
                if (!/rgba\(.*, 0\)$/.test(c) && c !== 'transparent') return c;
              }
              return 'rgb(255, 255, 255)';
            })(),
            text: getComputedStyle(el).color,
            glyph: getComputedStyle(g).color,
          };
        });
        expect(contrast(m.text, m.bg), `${state} label`).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(
          contrast(m.glyph, m.bg),
          `${state} glyph`,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
