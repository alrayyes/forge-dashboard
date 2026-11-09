import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { factsOf } from './check-facts';
import { serveChecks } from './checks-feed-helper';
import { test } from './server-fixture';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const STATES = [
  { state: 'success', label: 'Passed' },
  { state: 'failure', label: 'Failed' },
  { state: 'timed_out', label: 'Timed out' },
  { state: 'running', label: 'Running' },
  { state: 'queued', label: 'Queued' },
  { state: 'skipped', label: 'Skipped' },
  { state: 'cancelled', label: 'Cancelled' },
  { state: 'awaiting_approval', label: 'Waiting for approval' },
];

async function open(page: Page) {
  const now = new Date().toISOString();
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
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
  await serveChecks(page, () =>
    STATES.map((s) => ({
      name: `check-${s.state}`,
      ...factsOf(s.state),
      url:
        s.state === 'awaiting_approval'
          ? 'https://github.com/alrayyes/forge-dashboard/actions/runs/9'
          : '',
      required: true,
    })),
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

  test('a held workflow links to its page to approve it (#1933)', async ({
    page,
  }) => {
    const dialog = await open(page);
    const row = dialog.locator('.pipeline-check', {
      hasText: 'check-awaiting_approval',
    });
    await expect(row.getByRole('link')).toHaveText('Approve on GitHub');
    await expect(row).not.toContainText('Passed');
    await expect(row).not.toContainText('Running');
  });

  test('a row without a control says why (#3258)', async ({ page }) => {
    const dialog = await open(page);
    const hint = (state: string) =>
      dialog
        .locator('.pipeline-check', { hasText: `check-${state}` })
        .locator('.pipeline-check-hint');
    await expect(hint('skipped')).toHaveCount(0);
    await expect(hint('queued')).toHaveText('Not started yet.');
    for (const state of [
      'success',
      'failure',
      'timed_out',
      'running',
      'cancelled',
    ]) {
      await expect(hint(state)).toHaveText('No page for this check.');
    }
    // A held workflow has its approve link.
    await expect(hint('awaiting_approval')).toHaveCount(0);
    // Plain text, read once: no live region.
    await expect(
      dialog.locator(
        '.pipeline-check-hint[role], .pipeline-check-hint[aria-live]',
      ),
    ).toHaveCount(0);
  });

  test('a queued check with a page and a running GitHub job explain themselves (#3258)', async ({
    page,
  }) => {
    const url = 'https://github.com/alrayyes/forge-dashboard/actions/runs/9';
    const now = new Date().toISOString();
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
    await page.route('**/api/v1/dashboard*', (route: Route) =>
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
              ci: 'pending',
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
    await serveChecks(page, () => [
      { name: 'check-queued', ...factsOf('queued'), url, jobId: 1 },
      { name: 'check-running', ...factsOf('running'), url, jobId: 2 },
    ]);
    await page.goto('/pull-requests.html');
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const queued = dialog.locator('.pipeline-check', {
      hasText: 'check-queued',
    });
    await expect(queued.locator('.pipeline-check-hint')).toHaveText(
      'Not started yet.',
    );
    await expect(queued.getByRole('link')).toContainText('Open on GitHub');
    const running = dialog.locator('.pipeline-check', {
      hasText: 'check-running',
    });
    await expect(running.locator('.pipeline-check-hint')).toHaveText(
      'Output is available when it finishes.',
    );
    await expect(running.getByRole('link')).toContainText('Watch on GitHub');
  });

  test('a failed, timed-out or held required check carries its Blocking badge', async ({
    page,
  }) => {
    const dialog = await open(page);
    await expect(dialog.getByText('Blocking')).toHaveCount(3);
  });

  for (const theme of ['light', 'dark']) {
    test(`has no axe-core violations and clears contrast, ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const dialog = await open(page);
      // The owner's saved theme wins over a cookie on load, so set the
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
