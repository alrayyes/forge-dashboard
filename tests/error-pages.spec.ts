import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

// #1175, rules/error-pages.md: the dashboard's own 404 and 500 pages, in the
// app's look, with a way out and nothing about its internals. The build
// emits them as /404.html and /500.html; the Go server serves them with the
// real status for a path nothing matches or a failure (the backend half).

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const PAGES = [
  {
    path: '/404.html',
    title: 'Page not found',
    headline: 'Page not found',
    chip: '404',
  },
  {
    path: '/500.html',
    title: 'Something went wrong',
    headline: 'Something went wrong on our side',
    chip: '500',
  },
];

// The served HTML, not the hydrated DOM: the browser adds its own preload
// links with the page's origin, which isn't the app leaking anything.
async function expectNoInternals(page: Page, path: string) {
  const html = await (await page.request.get(path)).text();
  expect(html).not.toMatch(
    /node_modules|\.svelte|\.ts:\d|stack ?trace|at \S+ \(/i,
  );
  expect(html).not.toMatch(/localhost|127\.0\.0\.1|HTTP\/\d/);
}

test.describe('error pages (#1175)', () => {
  for (const { path, title, headline, chip } of PAGES) {
    test(`${path} says what happened, in plain words, and links home`, async ({
      page,
    }) => {
      await page.goto(path);

      await expect(page).toHaveTitle(new RegExp(title));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        headline,
      );
      await expect(page.locator('.error-status')).toContainText(chip);
      const home = page.getByRole('link', { name: 'Back to pull requests' });
      await expect(home).toHaveAttribute('href', '/');
      for (const [name, href] of [
        ['Issues', '/issues.html'],
        ['Releases', '/releases.html'],
        ['Insights', '/insights.html'],
        ['Settings', '/settings.html'],
      ]) {
        await expect(
          page
            .getByRole('navigation', { name: 'Where to go next' })
            .getByRole('link', { name }),
        ).toHaveAttribute('href', href);
      }
      await expectNoInternals(page, path);
    });

    test(`${path} has no axe-core violations at desktop and 375px, and no horizontal scroll`, async ({
      page,
    }) => {
      await page.goto(path);
      expect(
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
      ).toEqual([]);

      await page.setViewportSize({ width: 375, height: 800 });
      expect(
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
      ).toEqual([]);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test(`${path} follows the dark theme`, async ({
      page,
      context,
      baseURL,
    }) => {
      await context.addCookies([
        { name: 'forge-board-theme', value: 'dark', url: baseURL ?? '' },
      ]);
      await page.goto(path);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
      ).toEqual([]);
    });
  }

  test('the 500 page offers Try again', async ({ page }) => {
    await page.goto('/500.html');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('the 404 page offers no Try again, since the address is the problem', async ({
    page,
  }) => {
    await page.goto('/404.html');
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(
      0,
    );
  });
});
