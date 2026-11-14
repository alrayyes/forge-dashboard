import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { serveChecks } from './checks-feed-helper';
import { test } from './server-fixture';

// The run link sits in a footer under a divider, outside the scrolling body, so
// a long list never pushes it off screen (#3876).

const LINK_NAME = 'Open run on GitHub (opens in a new tab)';

function snapshot() {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: [
      {
        forge: 'github',
        repo: 'example/app',
        number: 42,
        title: 'Add structured logging',
        url: 'https://example.com/42',
        author: 'claude',
        draft: false,
        ci: 'success',
        checks: { passed: 4, running: 0, waiting: 0, failed: 0 },
        labels: [],
        createdAt: new Date(Date.now() - 3600_000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        mergeStatus: 'blocked',
        status: 'blocked',
        kind: 'regular',
        behind: false,
        allowedActions: [],
      },
    ],
    issues: [],
  };
}

function jobs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `job-${i + 1}`,
    status: 'completed',
    conclusion: 'success',
    url: `https://github.com/example/app/actions/runs/9/job/${i + 1}`,
  }));
}

async function open(
  page: Page,
  size: { width: number; height: number },
  count: number,
  scheme: 'light' | 'dark' = 'light',
  list: () => unknown[] = () => jobs(count),
) {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: scheme });
  await serveChecks(page, list);
  await page.route('**/api/v1/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot()),
    }),
  );
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: 'Open pipeline' })
    .click();
  await expect(page.locator('#pipeline-dialog .pipeline-check')).toHaveCount(
    count,
  );
}

const dialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Pipeline checks' });
const link = (page: Page) =>
  dialog(page).getByRole('link', { name: LINK_NAME });

// Reads the link's box until two reads in a row agree, so a slide-in or a late
// render can't decide the result.
async function settledBox(page: Page) {
  let last = '';
  let box: { x: number; y: number; width: number; height: number } | null =
    null;
  await expect
    .poll(async () => {
      box = await link(page).boundingBox();
      const now = JSON.stringify(box);
      const same = box !== null && now === last;
      last = now;
      return same;
    })
    .toBe(true);
  return box as unknown as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

async function insideViewport(page: Page) {
  const box = await settledBox(page);
  const view = page.viewportSize();
  if (!view) throw new Error('no viewport');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
}

const SIZES = [
  { width: 360, height: 640 },
  { width: 390, height: 780 },
  { width: 1280, height: 800 },
  { width: 844, height: 390 },
];

test.describe('pipeline dialog footer', () => {
  for (const size of SIZES) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const count of [4, 40]) {
        test(`the run link is on screen at ${size.width}x${size.height}, ${scheme}, ${count} checks`, async ({
          page,
        }) => {
          await open(page, size, count, scheme);
          await expect(link(page)).toBeVisible();
          await insideViewport(page);
        });
      }
    }
  }

  test('the run link stays on screen at 200% root font', async ({ page }) => {
    await open(page, { width: 390, height: 780 }, 40);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await expect
      .poll(() =>
        page.evaluate(
          () => getComputedStyle(document.documentElement).fontSize,
        ),
      )
      .toBe('32px');
    await insideViewport(page);
  });

  for (const size of [
    { width: 360, height: 640 },
    { width: 390, height: 780 },
    { width: 1280, height: 800 },
  ]) {
    test(`it is a real outlined button, 44px high, full width on a phone, at ${size.width}x${size.height}`, async ({
      page,
    }) => {
      await open(page, size, 40);
      const footer = dialog(page).locator('.pipeline-dialog-footer');
      await expect(footer.getByRole('link', { name: LINK_NAME })).toHaveCount(
        1,
      );
      await expect(
        dialog(page)
          .locator('.pipeline-dialog-body')
          .getByRole('link', { name: LINK_NAME }),
      ).toHaveCount(0);
      await settledBox(page);
      const m = await link(page).evaluate((el) => {
        const a = el.getBoundingClientRect();
        const f = el.parentElement?.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          height: a.height,
          width: a.width,
          footerWidth: f?.width ?? 0,
          border: Number.parseFloat(s.borderTopWidth),
          background: s.backgroundColor,
        };
      });
      expect(m.height).toBeGreaterThanOrEqual(44);
      expect(m.border).toBeGreaterThan(0);
      if (size.width < 761) expect(m.width).toBeGreaterThan(m.footerWidth - 40);
      await expect(link(page)).toHaveText('Open run on GitHub');
      await expect(link(page).locator('svg[aria-hidden="true"]')).toHaveCount(
        1,
      );
      await expect(link(page)).toHaveAttribute('target', '_blank');
      await expect(link(page)).toHaveAttribute('rel', /noopener/);
    });
  }

  const RUN = 'https://github.com/example/app/actions/runs';
  const job = (run: number, conclusion: string) => ({
    name: `job-${run}`,
    status: 'completed',
    conclusion,
    url: `${RUN}/${run}/job/1`,
  });

  test('several runs with a failure link the failed run and say so', async ({
    page,
  }) => {
    await open(page, SIZES[2], 2, 'light', () => [
      job(7, 'failure'),
      job(9, 'success'),
    ]);
    const failedLink = dialog(page).getByRole('link', {
      name: 'Open latest failed run on GitHub (opens in a new tab)',
    });
    await expect(failedLink).toHaveAttribute('href', `${RUN}/7`);
    await expect(failedLink).toHaveText('Open latest failed run on GitHub');
    await expect(dialog(page).getByText(/whole run/i)).toHaveCount(0);
  });

  test('several runs with nothing failed link the newest and say latest', async ({
    page,
  }) => {
    await open(page, SIZES[2], 2, 'light', () => [
      job(7, 'success'),
      job(9, 'success'),
    ]);
    const latest = dialog(page).getByRole('link', {
      name: 'Open latest run on GitHub (opens in a new tab)',
    });
    await expect(latest).toHaveAttribute('href', `${RUN}/9`);
  });

  test('no run id means no run link', async ({ page }) => {
    await open(page, SIZES[2], 1, 'light', () => [
      {
        name: 'external',
        status: 'completed',
        conclusion: 'success',
        url: 'https://ci.example/build/1',
      },
    ]);
    await expect(dialog(page).locator('.pipeline-dialog-footer a')).toHaveCount(
      0,
    );
  });

  test('a bottom safe-area inset pads the footer and keeps the button whole', async ({
    page,
  }) => {
    const inset = 34;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { bottom: inset },
    });
    await open(page, { width: 390, height: 780 }, 40);
    await insideViewport(page);
    const m = await dialog(page)
      .locator('.pipeline-dialog-footer')
      .evaluate((el) => {
        const s = getComputedStyle(el);
        const b = el.querySelector('a')?.getBoundingClientRect() as DOMRect;
        return {
          padBottom: Number.parseFloat(s.paddingBottom),
          buttonHeight: b.height,
          gap: window.innerHeight - b.bottom,
        };
      });
    expect(m.padBottom).toBeGreaterThanOrEqual(12 + inset);
    expect(m.buttonHeight).toBeGreaterThanOrEqual(44);
    expect(m.gap).toBeGreaterThanOrEqual(inset);
  });

  test('with no inset the footer keeps its 12px padding', async ({ page }) => {
    await open(page, { width: 390, height: 780 }, 40);
    const pad = await dialog(page)
      .locator('.pipeline-dialog-footer')
      .evaluate((el) => getComputedStyle(el).paddingBottom);
    expect(pad).toBe('12px');
  });

  test('on desktop it is at least 24px high and left aligned', async ({
    page,
  }) => {
    await open(page, { width: 1280, height: 800 }, 4);
    const box = await settledBox(page);
    const sheet = await dialog(page).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(24);
    expect((box?.x ?? 0) - (sheet?.x ?? 0)).toBeLessThan(40);
  });

  test('the body scrolls to its last row above the footer', async ({
    page,
  }) => {
    await open(page, { width: 390, height: 780 }, 40);
    const last = dialog(page).locator('.pipeline-check').last();
    await last.scrollIntoViewIfNeeded();
    await expect
      .poll(async () => {
        const lastBox = await last.boundingBox();
        const linkBox = await link(page).boundingBox();
        if (!lastBox || !linkBox) return false;
        return lastBox.y + lastBox.height <= linkBox.y;
      })
      .toBe(true);
  });

  test('it is the last stop in tab order', async ({ page }) => {
    await open(page, { width: 390, height: 780 }, 4);
    await dialog(page).getByRole('link', { name: /job-4/ }).first().focus();
    await page.keyboard.press('Tab');
    await expect(link(page)).toBeFocused();
    await expect(link(page)).toHaveCSS('outline-style', 'solid');
  });

  for (const mode of ['light', 'dark', 'forced'] as const) {
    test(`axe finds nothing in ${mode}`, async ({ page }) => {
      if (mode === 'forced')
        await page.emulateMedia({ forcedColors: 'active' });
      await open(
        page,
        { width: 390, height: 780 },
        40,
        mode === 'dark' ? 'dark' : 'light',
      );
      if (mode === 'forced')
        await page.emulateMedia({ forcedColors: 'active' });
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
