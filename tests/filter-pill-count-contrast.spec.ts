import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The count inside a Main branches filter pill is 12px text, so it needs 4.5:1
// (WCAG 1.4.3) against the pill fill once its own opacity is blended in. It was
// white at opacity .85 on the teal fill of the active pill: 4.04:1.
// https://github.com/alrayyes/forge-dashboard/issues/3317

async function seed(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [],
        repos: [{ forge: 'github', fullName: 'acme/a', hasWebhook: true }],
        firstRefreshDone: true,
      }),
    }),
  );
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 1,
          passed: 1,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: 2,
        },
        branches: ['a', 'b'].map((n, i) => ({
          forge: 'github',
          fullName: `acme/${n}`,
          url: `https://example.com/acme/${n}`,
          branch: 'main',
          status: i ? 'failed' : 'passed',
          commit: {
            sha: 'd98f3c2',
            subject: 'fix: a change',
            author: 'dev',
            committedAt: new Date().toISOString(),
          },
          failingJobs: [],
          finishedAt: new Date().toISOString(),
          durationSeconds: 60,
          runUrl: `https://example.com/acme/${n}/actions/runs/1`,
          staleSince: null,
        })),
      }),
    }),
  );
}

// Each count's contrast against its pill, with the count's opacity blended in.
async function countContrasts(page: Page) {
  return page.locator('.mb-bar .mb-pill .mb-count').evaluateAll((counts) => {
    type Rgb = [number, number, number];
    const parse = (v: string) => {
      const m = v.match(/rgba?\(([^)]+)\)/);
      if (!m) throw new Error(`not a colour: ${v}`);
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).map(Number);
      return { rgb: [r, g, b] as Rgb, a };
    };
    const lum = ([r, g, b]: Rgb) => {
      const [x, y, z] = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * x + 0.7152 * y + 0.0722 * z;
    };
    return counts.map((count) => {
      const pill = count.closest('.mb-pill') as HTMLElement;
      const bg = parse(getComputedStyle(pill).backgroundColor);
      const fg = parse(getComputedStyle(count).color);
      let opacity = 1;
      for (let el: Element | null = count; el; el = el.parentElement) {
        opacity *= Number(getComputedStyle(el).opacity);
      }
      const alpha = fg.a * opacity;
      const blended = fg.rgb.map(
        (c, i) => c * alpha + bg.rgb[i] * (1 - alpha),
      ) as Rgb;
      const [hi, lo] = [lum(blended), lum(bg.rgb)].sort((a, b) => b - a);
      return {
        pressed: pill.getAttribute('aria-pressed') === 'true',
        ratio: (hi + 0.05) / (lo + 0.05),
      };
    });
  });
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [390, 820, 1280]) {
    test(`pill counts are 4.5:1 in ${scheme} at ${width}px`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 800 });
      await seed(page);
      await page.goto('/');
      await expect(page.locator('.mb-bar .mb-pill').first()).toBeVisible();

      await expect
        .poll(async () => {
          const ratios = await countContrasts(page);
          return {
            hasPressed: ratios.some((r) => r.pressed),
            hasUnpressed: ratios.some((r) => !r.pressed),
            low: ratios
              .filter(({ ratio }) => ratio < 4.5)
              .map(
                ({ pressed, ratio }) =>
                  `${pressed ? 'active' : 'inactive'} pill count ${ratio}`,
              ),
          };
        })
        .toEqual({ hasPressed: true, hasUnpressed: true, low: [] });

      if (width === 390) {
        const results = await new AxeBuilder({ page })
          .withRules(['color-contrast'])
          .analyze();
        expect(results.violations).toEqual([]);
      }
    });
  }
}
