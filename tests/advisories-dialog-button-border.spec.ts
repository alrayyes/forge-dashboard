import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The severity pills, Open on GitHub, Back and the X in the advisories dialog
// use the standard button border, --control-border, so each reads as a button
// before it is hovered (WCAG 2.2 SC 1.4.11). The provider chip is not a
// control and keeps its decorative border.
// https://github.com/alrayyes/forge-dashboard/issues/3902

type Rgb = [number, number, number];

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The control's border colour, the --control-border token as the browser
// resolves it, and the first opaque background above the control.
async function edge(
  control: Locator,
): Promise<{ border: Rgb; token: Rgb; behind: Rgb }> {
  return control.evaluate((el) => {
    const parse = (value: string) => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      if (!m) throw new Error(`not a colour: ${value}`);
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).map(Number);
      return { rgb: [r, g, b] as Rgb, alpha: a };
    };
    const probe = document.createElement('span');
    probe.style.color = 'var(--control-border)';
    el.appendChild(probe);
    const token = parse(getComputedStyle(probe).color).rgb;
    probe.remove();
    let node: Element | null = el.parentElement;
    let behind: Rgb = [255, 255, 255];
    while (node) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg.alpha === 1) {
        behind = bg.rgb;
        break;
      }
      node = node.parentElement;
    }
    return {
      border: parse(getComputedStyle(el).borderTopColor).rgb,
      token,
      behind,
    };
  });
}

const REPO = 'acme/scanner';
const LIST_URL = `https://example.com/${REPO}/security/dependabot`;

const advisory = (n: number, severity: string) => ({
  number: n,
  state: 'open',
  severity,
  summary: `Flaw ${n}`,
  ghsaId: `GHSA-aaaa-bbbb-${n}`,
  package: `pkg-${n}`,
  ecosystem: 'pip',
  manifestPath: 'requirements.txt',
  openedAt: new Date(Date.now() - n * 86_400_000).toISOString(),
  patchedVersion: '2.0.0',
  url: `${LIST_URL}/${n}`,
});

async function open(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/main-branches/advisories*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'known',
        url: LIST_URL,
        advisories: [advisory(1, 'critical'), advisory(2, 'high')],
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
          failed: 0,
          passed: 1,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: 1,
        },
        branches: [
          {
            forge: 'github',
            fullName: REPO,
            url: `https://example.com/${REPO}`,
            branch: 'main',
            status: 'passed',
            commit: {
              sha: 'd98f3c2',
              subject: 'fix: a change',
              author: 'dev',
              committedAt: new Date().toISOString(),
            },
            failingJobs: [],
            finishedAt: null,
            durationSeconds: null,
            runUrl: `https://example.com/${REPO}/actions/runs/1`,
            checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
            latestRelease: null,
            staleSince: null,
            advisories: {
              state: 'known',
              count: 2,
              highest: 'critical',
              url: LIST_URL,
            },
          },
        ],
      }),
    }),
  );
  await page.goto('/');
  await page.getByTestId('main-branch-advisories').click();
  await expect(page.getByTestId('advisories-dialog')).toBeVisible();
  await expect(page.getByTestId('advisory-row')).toHaveCount(2);
}

async function expectStandardBorder(control: Locator, label: string) {
  await expect(control, label).toBeVisible();
  const { border, token, behind } = await edge(control);
  expect(border, `${label} uses --control-border`).toEqual(token);
  expect(contrast(border, behind), `${label} contrast`).toBeGreaterThanOrEqual(
    3,
  );
}

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`the dialog buttons have the standard border in ${scheme} at ${width}px`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const dialog = page.getByTestId('advisories-dialog');

      // List view: every pill (pressed and not), the X, the footer Close.
      const pills = dialog.locator('.adv-filter');
      await expect(pills).toHaveCount(3);
      await dialog.getByTestId('advisory-filter-critical').click();
      for (const [i, pill] of (await pills.all()).entries()) {
        const pressed = await pill.getAttribute('aria-pressed');
        if (pressed === 'true') {
          continue;
        }
        await expectStandardBorder(pill, `pill ${i}`);
      }
      await expectStandardBorder(dialog.locator('.adv-close'), 'close X');
      await expectStandardBorder(
        dialog.locator('.adv-footer .adv-ghost'),
        'footer Close',
      );
      expect(
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
      ).toEqual([]);

      // Detail view: Back and Open on GitHub.
      await page.getByTestId('advisory-row').first().click();
      await expect(page.getByTestId('advisory-detail')).toBeVisible();
      await expectStandardBorder(dialog.getByTestId('advisory-back'), 'Back');
      await expectStandardBorder(
        dialog.getByTestId('advisory-open-on-forge'),
        'Open on GitHub',
      );
      expect(
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
      ).toEqual([]);
    });
  }
}

test('the pressed pill keeps its ink fill and border in light', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page);
  const pill = page.getByTestId('advisory-filter-critical');
  await pill.click();
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await expect(pill).toHaveCSS('background-color', 'rgb(16, 24, 38)');
  await expect(pill).toHaveCSS('border-top-color', 'rgb(16, 24, 38)');
});

test('the provider chip keeps its decorative border', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page);
  const chip = page.locator('.adv-source').first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveCSS('border-top-color', 'rgb(217, 224, 232)');
});

test('forced colors still marks the pressed pill with a 3px border', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await open(page);
  const pill = page.getByTestId('advisory-filter-critical');
  await pill.click();
  await expect(pill).toHaveCSS('border-top-width', '3px');
  expect(
    (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations,
  ).toEqual([]);
});
