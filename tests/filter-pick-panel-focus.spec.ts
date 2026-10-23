import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A live update redraws the open Repo and Author panels. The reader who is on
// a checkbox with the keyboard must stay on that checkbox, including when the
// update changes how the rows are laid out (a second forge makes the repos
// group under their forge).

function pr(
  forge: string,
  repo: string,
  author: string,
  n: number,
): Record<string, unknown> {
  return {
    forge,
    repo,
    number: n,
    title: `Change ${n}`,
    url: `https://example.com/${n}`,
    author,
    draft: false,
    ci: 'success',
    mergeStatus: 'mergeable',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const snapshot = (prs: Record<string, unknown>[]) => ({
  generatedAt: new Date().toISOString(),
  forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
  pullRequests: prs,
  issues: [],
  repos: [],
  hiddenDrafts: 0,
});

const ONE_FORGE = [
  pr('github', 'alrayyes/app', 'alice', 1),
  pr('github', 'alrayyes/lib', 'bob', 2),
];
const TWO_FORGES = [...ONE_FORGE, pr('forgejo', 'team/site', 'carol', 3)];

async function open(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __streams: EventSource[];
      EventSource: typeof EventSource;
    };
    w.__streams = [];
    const Real = w.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        w.__streams.push(this);
      }
    };
  });
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({ json: snapshot(ONE_FORGE) }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(ONE_FORGE.length);
}

async function push(page: Page, prs: Record<string, unknown>[]) {
  await page.evaluate(
    (data) => {
      const w = window as unknown as { __streams: EventSource[] };
      for (const stream of w.__streams)
        stream.onmessage?.(new MessageEvent('message', { data }));
    },
    JSON.stringify(snapshot(prs)),
  );
}

const focusedLabel = (page: Page) =>
  page.evaluate(
    () =>
      (document.activeElement as HTMLInputElement | null)?.closest('label')
        ?.textContent ?? document.activeElement?.tagName,
  );

test.describe('the open pick panel keeps keyboard focus through a redraw', () => {
  // Only the repos move: they group under their forge. The authors are a flat
  // list that never reorders in place, so their path is the removal test below.
  for (const [kind, button, start, second, next, after] of [
    [
      'repo',
      '#shared-repo-filter-button',
      'alrayyes/lib',
      'alrayyes/app',
      TWO_FORGES,
      3,
    ],
  ] as const) {
    test(`${kind}: focus stays on the box through a snapshot that moves the rows`, async ({
      page,
    }) => {
      await open(page);
      await page.locator(button).first().focus();
      await page.keyboard.press('Enter');
      const host = page.locator(button).first().locator('xpath=..');
      const target = host.getByRole('checkbox', { name: start });
      await target.focus();
      await expect(target).toBeFocused();

      await push(page, next);
      await expect(page.locator('#pr-rows > .row')).toHaveCount(after);
      await expect(target).toBeFocused();
      expect(await focusedLabel(page)).toContain(start);

      // Space still ticks the box the reader is on, and a snapshot back to
      // one forge keeps them there.
      await page.keyboard.press('Space');
      await expect(target).toBeChecked();
      await push(page, ONE_FORGE);
      await expect(target).toBeFocused();

      // The box next door is one Shift+Tab away.
      await page.keyboard.press('Shift+Tab');
      await expect(host.getByRole('checkbox', { name: second })).toBeFocused();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('a box whose choice goes away hands focus to the panel button, not the page', async ({
    page,
  }) => {
    await open(page);
    const button = page.locator('#shared-author-filter-button').first();
    await button.focus();
    await page.keyboard.press('Enter');
    const bob = page.getByRole('checkbox', { name: 'bob' });
    await bob.focus();
    await push(page, [ONE_FORGE[0]]);
    await expect(page.getByRole('checkbox', { name: 'bob' })).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'bob is no longer offered' })
        .first(),
    ).toBeAttached();
  });
});
