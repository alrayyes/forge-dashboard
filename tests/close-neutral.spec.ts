import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import { test } from './server-fixture';

// Close pull request is an outlined danger button with a pull-request-closed
// glyph, so it can't be taken for the dialog's own plain Close (the header X).
// Only the confirm step carries the warning tone. The look is the same on the
// row and in the footer, whether or not Close is the primary action.
// https://github.com/alrayyes/forge-dashboard/issues/2057

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

function mockDashboard(page: Page, pr: Record<string, unknown>) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pr],
        issues: [],
      }),
    }),
  );
}

const row = (page: Page) => page.locator('#pr-rows .row').first();
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const details = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });

// The Close button in the row's dialog footer, which is opened.
async function closeButton(page: Page): Promise<Locator> {
  const dialog = await openActionsDialog(row(page));
  return actionsFooter(dialog).getByRole('button', {
    name: 'Close pull request',
    exact: true,
  });
}

const background = (el: Locator) =>
  el.evaluate((node) => getComputedStyle(node).backgroundColor);

// A design token's resolved colour, read off a probe so the test compares
// against the page's own palette and not a hard-coded hex.
async function token(page: Page, name: string) {
  return page.evaluate((n) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = `var(${n})`;
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }, name);
}

test.describe("Close pull request looks unlike the dialog's own close", () => {
  test.beforeEach(async ({ page }) => {
    // The live stream would push the server's own, newer snapshot over the
    // mock, and the page drops the older one as stale.
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
  });

  test('it is an outlined danger button, not filled and not green', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'blocked', ci: 'failure' }),
    );
    await page.goto('/pull-requests.html');
    const close = await closeButton(page);
    await expect(close).not.toHaveClass(/suggested/);
    const style = await close.evaluate((node) => {
      const s = getComputedStyle(node);
      return { bg: s.backgroundColor, fg: s.color, border: s.borderTopColor };
    });
    expect(style.bg).toBe('rgba(0, 0, 0, 0)');
    expect(style.fg).toBe(await token(page, '--critical'));
    expect(style.border).toBe(await token(page, '--critical'));
  });

  test('it carries the pull-request-closed glyph, hidden from assistive tech, and the header X stays the only plain Close', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'blocked', ci: 'failure' }),
    );
    await page.goto('/pull-requests.html');
    const close = await closeButton(page);
    await expect(close.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    await expect(close).toHaveAccessibleName('Close pull request');
    await expect(
      details(page).getByRole('button', { name: 'Close details' }),
    ).toHaveCount(1);
  });

  test('with nothing to merge it keeps the same look when it is the primary action', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'mergeable', empty: true }),
    );
    await page.goto('/pull-requests.html');
    const close = await closeButton(page);
    await expect(close).not.toHaveClass(/suggested/);
    expect(await background(close)).toBe('rgba(0, 0, 0, 0)');
    expect(await close.evaluate((n) => getComputedStyle(n).color)).toBe(
      await token(page, '--critical'),
    );
  });

  for (const theme of ['light', 'dark']) {
    test(`its text is at least 4.5:1 on the footer and its target is 44px on a phone, ${theme}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await context.addCookies([
        { name: 'forge-board-theme', value: theme, url: baseURL ?? '' },
      ]);
      await page.setViewportSize({ width: 390, height: 800 });
      await mockDashboard(
        page,
        makePR({ mergeStatus: 'blocked', ci: 'failure' }),
      );
      await page.goto('/pull-requests.html');
      const close = await closeButton(page);
      const { ratio, height } = await close.evaluate((node) => {
        const parse = (s: string) =>
          (s.match(/[\d.]+/g) ?? []).map(Number) as number[];
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => {
            const c = v / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        let backdrop = [255, 255, 255];
        for (let el = node.parentElement; el; el = el.parentElement) {
          const c = parse(getComputedStyle(el).backgroundColor);
          if (c.length >= 3 && (c[3] ?? 1) === 1) {
            backdrop = c;
            break;
          }
        }
        const [hi, lo] = [
          lum(parse(getComputedStyle(node).color)),
          lum(backdrop),
        ].sort((x, y) => y - x);
        return {
          ratio: (hi + 0.05) / (lo + 0.05),
          height: node.getBoundingClientRect().height,
        };
      });
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      expect(height).toBeGreaterThanOrEqual(44);
    });
  }

  test('the button and its confirm name the object, and the confirm carries the warning tone', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'blocked', ci: 'failure' }),
    );
    await page.goto('/pull-requests.html');
    const close = await closeButton(page);
    await expect(close).toHaveText('Close pull request');
    await expect(close).toHaveAccessibleName('Close pull request');

    await close.click();
    const confirm = details(page).getByRole('button', {
      name: 'Confirm close pull request?',
    });
    await expect(confirm).toBeVisible();
    expect(await background(confirm)).toBe(await token(page, '--warning-bg'));
    await expect(
      details(page).getByRole('button', { name: 'Cancel' }),
    ).toBeVisible();
  });

  for (const theme of ['light', 'dark']) {
    test(`has no axe-core violations with Close and its confirm showing, ${theme}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await context.addCookies([
        { name: 'forge-board-theme', value: theme, url: baseURL ?? '' },
      ]);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await mockDashboard(
        page,
        makePR({ mergeStatus: 'mergeable', empty: true }),
      );
      await page.goto('/pull-requests.html');
      const close = await closeButton(page);
      expect(
        (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations,
      ).toEqual([]);

      await close.click();
      await expect(
        details(page).getByRole('button', {
          name: 'Confirm close pull request?',
        }),
      ).toBeVisible();
      expect(
        (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations,
      ).toEqual([]);
    });
  }
});
