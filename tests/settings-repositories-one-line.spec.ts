import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A repo row in Settings, Repositories is one line: forge marker, repo name
// (truncated), then the Auto-update, Rebase bots and Ignore icons. Where the
// three icons and the name can't share a line, the icons drop to one line
// under the name. Never three lines.
// https://github.com/alrayyes/forge-dashboard/issues/4858

const LONG = 'a-very-long-repository-name-that-keeps-going-and-going';

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  forge: 'github',
  fullName: `owner/${name}`,
  url: `https://example.test/owner/${name}`,
  hasWebhook: true,
  canManageWebhooks: true,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
  rebaseBots: false,
  ...extra,
});

async function open(
  page: Page,
  width: number,
  scheme: 'light' | 'dark',
  repos = [repo('app'), repo(LONG, { forge: 'forgejo' })],
) {
  await page.setViewportSize({ width, height: 800 });
  await page.emulateMedia({ colorScheme: scheme });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos,
      }),
    }),
  );
  await page.goto('/settings.html#repositories');
  await page.locator('#repositories-rows tr').first().waitFor();
}

const rowOf = (page: Page, name: string) =>
  page.locator('#repositories-rows tr').filter({ hasText: name });

const mockWrites = (page: Page) =>
  page.route(
    '**/api/v1/repos/{auto-update-branch,rebase-bots}/*',
    (route: Route) => route.fulfill({ status: 204 }),
  );

const rect = async (loc: ReturnType<Page['locator']>) =>
  (await loc.boundingBox())!;

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5;

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [320, 390, 1280]) {
    for (const zoom of [100, 175]) {
      test(`${width}px, ${zoom}% text, ${scheme}: at most two lines, no overlap, never clipped`, async ({
        page,
      }) => {
        await open(page, width, scheme);
        if (zoom !== 100) {
          await page.addStyleTag({
            content: `html { font-size: ${zoom}% !important; }`,
          });
        }
        const rows = page.locator('#repositories-rows tr');
        for (const row of await rows.all()) {
          const tr = await rect(row);
          const badge = await rect(row.locator('.forge-badge'));
          const name = await rect(row.locator('.repo-line-name'));
          const buttons = [
            row.getByRole('button', { name: /^Auto-update on / }),
            row.getByRole('button', { name: /^Rebase bots on / }),
            row.getByRole('combobox', { name: /^Ignore / }),
          ];
          const boxes = [];
          for (const b of buttons) boxes.push(await rect(b));
          // Every piece sits inside the row, none on another.
          for (const box of [badge, name, ...boxes]) {
            expect(box.x).toBeGreaterThanOrEqual(tr.x - 0.5);
            expect(box.x + box.width).toBeLessThanOrEqual(
              tr.x + tr.width + 0.5,
            );
          }
          const pieces = [badge, name, ...boxes];
          for (let i = 0; i < pieces.length; i++) {
            for (let j = i + 1; j < pieces.length; j++) {
              expect(overlaps(pieces[i], pieces[j])).toBe(false);
            }
          }
          // The icons share one line, and the name has room for a few letters.
          expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1);
          // The name keeps at least 12 characters on a phone, in either layout.
          const twelveCh = await row.evaluate((el) => {
            const probe = document.createElement('i');
            probe.style.cssText = 'display:block;width:12ch;height:1px';
            el.querySelector('.repo-line-name')?.appendChild(probe);
            const w = probe.getBoundingClientRect().width;
            probe.remove();
            return w;
          });
          expect(name.width).toBeGreaterThan(24);
          if (width <= 760)
            expect(name.width).toBeGreaterThanOrEqual(twelveCh - 1);
          // One line, or two when the icons drop under the name; the icons
          // are never stacked.
          const sameLine =
            Math.abs(
              boxes[0].y + boxes[0].height / 2 - (name.y + name.height / 2),
            ) < 12;
          // One line at 390px at normal text; the fallback at 320px and at
          // 175% text on a phone.
          if (width === 390 && zoom === 100) expect(sameLine).toBe(true);
          if (width === 320 || (width === 390 && zoom === 175))
            expect(sameLine).toBe(false);
          if (width <= 760 && !sameLine)
            expect(boxes[0].y).toBeGreaterThanOrEqual(name.y + name.height - 1);
          // Tap targets: 44px on a phone.
          if (width <= 760) {
            for (const b of boxes) {
              expect(b.width).toBeGreaterThanOrEqual(44);
              expect(b.height).toBeGreaterThanOrEqual(44);
            }
          }
        }
        if (width <= 760) {
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
            ),
          ).toBeLessThanOrEqual(0);
        }
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }

  test(`${scheme}: the long name is cut with an ellipsis and keeps its full name`, async ({
    page,
  }) => {
    await open(page, 320, scheme);
    const name = rowOf(page, LONG).locator('.repo-line-name');
    expect(await name.evaluate((el) => getComputedStyle(el).textOverflow)).toBe(
      'ellipsis',
    );
    await expect(name.getByRole('link')).toHaveAccessibleName(`owner/${LONG}`);
    await expect(name.getByRole('link')).toHaveAttribute(
      'title',
      `owner/${LONG}`,
    );
  });
}

test('each icon toggles and the row keeps its place', async ({ page }) => {
  await open(page, 390, 'light');
  await mockWrites(page);
  const row = rowOf(page, 'owner/app');
  const place = () =>
    row.evaluate((el) => ({
      index: Array.from(el.parentElement?.children ?? []).indexOf(el),
      height: el.getBoundingClientRect().height,
    }));
  const before = await place();
  for (const name of [/^Auto-update on /, /^Rebase bots on /]) {
    const button = row.getByRole('button', { name });
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await place()).toEqual(before);
  }
  // Ignore keeps its scope choice: prs, issues, both.
  const ignore = row.getByRole('combobox', { name: /^Ignore / });
  await expect(ignore.locator('option:not([disabled])')).toHaveCount(3);
});

test('the tooltip shows on hover and keyboard focus, names the state, and Escape dismisses it (WCAG 1.4.13)', async ({
  page,
}) => {
  await open(page, 1280, 'light');
  await mockWrites(page);
  const row = rowOf(page, 'owner/app');
  const toggle = row.getByRole('button', { name: /^Auto-update on / });
  const host = row.locator('.repo-control').first();
  const tip = () =>
    host.evaluate((el) => {
      const s = getComputedStyle(el, '::after');
      return {
        text: s.content,
        visible: s.visibility === 'visible' && s.opacity !== '0',
      };
    });
  expect(await tip()).toMatchObject({ visible: false });
  await toggle.hover();
  expect(await tip()).toEqual({
    text: '"Auto-update: off. Press to turn on"',
    visible: true,
  });
  await page.keyboard.press('Escape');
  expect(await tip()).toMatchObject({ visible: false });
  await page.mouse.move(0, 0);
  await toggle.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  expect(await tip()).toMatchObject({ visible: true });
  await page.keyboard.press('Escape');
  expect(await tip()).toMatchObject({ visible: false });
  // The tooltip sits above the control, so it never covers a neighbour.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.focus();
  expect((await tip()).text).toBe('"Auto-update: on. Press to turn off"');
});

test('the forge marker names the forge in text', async ({ page }) => {
  await open(page, 320, 'dark');
  await expect(rowOf(page, 'owner/app').locator('.forge-badge')).toContainText(
    'GitHub',
  );
  await expect(rowOf(page, LONG).locator('.forge-badge')).toContainText(
    'Forgejo',
  );
});

test('extra lines stay below the icons and only appear when needed', async ({
  page,
}) => {
  await open(page, 390, 'light', [
    repo('quiet'),
    repo('noisy', { hasWebhook: false }),
  ]);
  const quiet = rowOf(page, 'quiet');
  const noisy = rowOf(page, 'noisy');
  await expect(quiet.getByTestId('polling-reason')).toHaveCount(0);
  const note = await rect(noisy.getByTestId('polling-reason'));
  const ignore = await rect(noisy.getByRole('combobox', { name: /^Ignore / }));
  expect(note.y).toBeGreaterThanOrEqual(ignore.y + ignore.height - 1);
});

test('a focused repo link keeps its whole focus ring inside the cut-off name', async ({
  page,
}) => {
  await open(page, 390, 'light');
  const link = rowOf(page, 'owner/app').locator('.repo-link');
  await link.focus();
  await expect(link).toBeFocused();
  const ring = await link.evaluate((a) => {
    const s = getComputedStyle(a);
    const box = a.getBoundingClientRect();
    const name = (
      a.closest('.repo-line-name') as HTMLElement
    ).getBoundingClientRect();
    return {
      style: s.outlineStyle,
      offset: parseFloat(s.outlineOffset),
      width: parseFloat(s.outlineWidth),
      insideLeft: box.left - name.left,
      insideTop: box.top - name.top,
      insideBottom: name.bottom - box.bottom,
    };
  });
  expect(ring.style).toBe('solid');
  // A negative offset draws the ring inside the link's box, which the name
  // contains, so overflow: hidden cannot clip it.
  expect(ring.offset).toBeLessThanOrEqual(-ring.width);
  expect(ring.insideLeft).toBeGreaterThanOrEqual(0);
  expect(ring.insideTop).toBeGreaterThanOrEqual(0);
  expect(ring.insideBottom).toBeGreaterThanOrEqual(0);
});

test('a phone row is five cells and every control has a name', async ({
  page,
}) => {
  await open(page, 390, 'light');
  const row = rowOf(page, 'owner/app');
  await expect(row.getByRole('cell')).toHaveCount(5);
  await expect(
    row.getByRole('button', { name: 'Auto-update on owner/app' }),
  ).toBeVisible();
  await expect(
    row.getByRole('button', { name: 'Rebase bots on owner/app' }),
  ).toBeVisible();
  await expect(
    row.getByRole('combobox', { name: 'Ignore owner/app' }),
  ).toBeVisible();
  await expect(row.getByRole('link', { name: 'owner/app' })).toBeVisible();
});

test('the tooltip is hoverable: the pointer can cross onto it without it closing (WCAG 1.4.13)', async ({
  page,
}) => {
  await open(page, 1280, 'light');
  const row = rowOf(page, 'owner/app');
  const toggle = row.getByRole('button', { name: /^Auto-update on / });
  const host = row.locator('.repo-control').first();
  const shown = () =>
    host.evaluate((el) => {
      const s = getComputedStyle(el, '::after');
      return s.visibility === 'visible' && s.opacity !== '0';
    });
  const box = await rect(host);
  await toggle.hover();
  expect(await shown()).toBe(true);
  // Up through the 6px gap and onto the tip, in small steps.
  await page.mouse.move(box.x + box.width - 3, box.y - 12, { steps: 20 });
  expect(await shown()).toBe(true);
  // The open tip's box misses every control on the page, so it never covers a
  // neighbouring icon.
  const tip = await host.evaluate((el) => {
    const s = getComputedStyle(el, '::after');
    const h = el.getBoundingClientRect();
    const extraX =
      s.boxSizing === 'border-box'
        ? 0
        : parseFloat(s.paddingLeft) +
          parseFloat(s.paddingRight) +
          parseFloat(s.borderLeftWidth) +
          parseFloat(s.borderRightWidth);
    const extraY =
      s.boxSizing === 'border-box'
        ? 0
        : parseFloat(s.paddingTop) +
          parseFloat(s.paddingBottom) +
          parseFloat(s.borderTopWidth) +
          parseFloat(s.borderBottomWidth);
    const width = parseFloat(s.width) + extraX;
    const height = parseFloat(s.height) + extraY;
    const bottom = h.top - (parseFloat(s.bottom) - h.height);
    return {
      x: h.right - parseFloat(s.right) - width,
      y: bottom - height,
      width,
      height,
    };
  });
  expect(tip.width).toBeGreaterThan(40);
  const others = await page.locator('.repo-control').evaluateAll(
    (els, mine) => {
      return els
        .map((e) => e.getBoundingClientRect())
        .filter((r) => !(r.x === mine.x && r.y === mine.y))
        .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
    },
    { x: box.x, y: box.y },
  );
  expect(others.length).toBeGreaterThan(1);
  for (const o of others) expect(overlaps(tip, o)).toBe(false);
  await page.mouse.move(0, 0);
  expect(await shown()).toBe(false);
});

test('Escape closes the tooltip and is left alone for a dialog', async ({
  page,
}) => {
  await open(page, 1280, 'light');
  const toggle = rowOf(page, 'owner/app').getByRole('button', {
    name: /^Auto-update on /,
  });
  type Win = { escapes: boolean[] };
  await page.evaluate(() => {
    (window as unknown as Win).escapes = [];
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape')
        (window as unknown as Win).escapes.push(e.defaultPrevented);
    });
  });
  await toggle.focus();
  await page.keyboard.press('Escape');
  // The key still bubbles unprevented, so an open dialog still sees it.
  expect(await page.evaluate(() => (window as unknown as Win).escapes)).toEqual(
    [false],
  );
});
