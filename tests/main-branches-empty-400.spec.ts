import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The Branches empty states ("No repositories are tracked yet." and "Nothing
// matches these filters.") stay inside the viewport at 400% text, so the page
// never scrolls sideways when there is nothing to list (#4638, found fixing
// #4631). Only the empty block is measured: the page header's width at this
// size is #4631's matter.
// https://github.com/alrayyes/forge-dashboard/issues/4638
// https://www.w3.org/WAI/WCAG22/Understanding/reflow.html

function branch(name: string) {
  return {
    forge: 'github',
    fullName: name,
    url: `https://example.com/${name}`,
    branch: 'main',
    status: 'passed',
    commit: {
      sha: 'd98f3c2',
      subject: 'fix: a change',
      author: 'dev',
      committedAt: new Date().toISOString(),
    },
    failingJobs: [],
    finishedAt: new Date().toISOString(),
    durationSeconds: 60,
    runUrl: `https://example.com/${name}/actions/runs/1`,
    staleSince: null,
  };
}

type State = 'no-repos' | 'no-match';

async function open(
  page: Page,
  state: State,
  width = 1280,
  scheme: 'light' | 'dark' = 'light',
) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 800 });
  const tracked = state === 'no-match';
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github'), forgeHealth('forgejo')],
        pullRequests: [],
        issues: [],
        repos: tracked
          ? [{ forge: 'github', fullName: 'acme/a', hasWebhook: true }]
          : [],
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
        counts: {},
        branches: tracked ? [branch('acme/a')] : [],
      }),
    }),
  );
  await page.goto('/');
  if (state === 'no-match') {
    await page.getByRole('searchbox').fill('zqxjk');
  }
  await expect(page.getByTestId(state)).toBeVisible();
}

const wide = (page: Page, state: State) =>
  page.evaluate((id) => {
    const box = document.querySelector(`[data-testid="${id}"]`);
    if (!box) return ['missing'];
    return [box, ...box.querySelectorAll('*')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > window.innerWidth + 1 || r.left < -1;
      })
      .map((e) => `${e.tagName}.${e.className}`);
  }, state);

for (const state of ['no-repos', 'no-match'] as const) {
  test(`${state} at 320px and 400% text stays inside the viewport`, async ({
    page,
  }) => {
    await open(page, state, 320);
    await page.addStyleTag({ content: 'html { font-size: 400% }' });
    expect(await wide(page, state)).toEqual([]);
    const sw = await page.getByTestId(state).evaluate((el) => ({
      box: el.scrollWidth - el.clientWidth,
    }));
    expect(sw.box).toBeLessThanOrEqual(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390, 320]) {
      test(`${state} has no axe violations at ${width}px in ${scheme}`, async ({
        page,
      }) => {
        await open(page, state, width, scheme);
        const { violations } = await new AxeBuilder({ page })
          .include(`[data-testid="${state}"]`)
          .analyze();
        expect(violations.map((v) => v.id)).toEqual([]);
      });
    }
  }

  test(`${state} has no axe violations in forced colours`, async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, state);
    const { violations } = await new AxeBuilder({ page })
      .include(`[data-testid="${state}"]`)
      .analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
    const edge = await page
      .getByTestId(state)
      .evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect(edge).not.toBe('none');
  });
}
