import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// A Dependabot row while the forge isn't answering: the Rebase split button
// and the Recreate item share one left edge, nothing overlaps, and the stale
// note is said once.
// https://github.com/alrayyes/forge-dashboard/issues/4187

const HELD = {
  code: 'held',
  message:
    "Showing data. The forge isn't answering yet, so this may be an earlier answer, and no action can run until it does.",
};

const PR = {
  forge: 'github',
  repo: 'alrayyes/washy-washy-cli',
  number: 324,
  title: 'Bump a dependency',
  url: 'https://github.com/alrayyes/washy-washy-cli/pull/324',
  author: 'dependabot',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'blocked',
  behind: true,
  status: {
    code: 'behind',
    message: 'Behind the base branch',
    next: 'Bring it up to date to unlock Merge',
    action: 'dependabot_rebase',
  },
  kind: 'dependency',
  allowedActions: [
    { action: 'dependabot_rebase', blocked: HELD },
    { action: 'dependabot_recreate', blocked: HELD },
  ],
};

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  // No fade, so a hover bubble is fully shown or fully hidden when measured.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [
          forgeHealth('github', {
            reachable: false,
            errorKind: 'unreachable',
            error: 'timeout',
            staleSince: new Date(Date.now() - 10 * 60_000).toISOString(),
          }),
        ],
        pullRequests: [PR],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/bots.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
  const row = page.locator('#pr-rows > .row').first();
  const toggle = row.getByRole('button', { name: 'More Dependabot actions' });
  if (await toggle.count()) await toggle.click();
  return row;
}

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

for (const [name, width] of [
  ['desktop', 1280],
  ['phone', 375],
] as const) {
  test(`${name}: Rebase and Recreate line up and the stale note is said once`, async ({
    page,
  }, info) => {
    const row = await open(page, width);
    await row.screenshot({ path: info.outputPath(`stale-${name}.png`) });

    const rebase = row.getByRole('button', { name: /Dependabot: Rebase/ });
    const chevron = row.getByRole('button', {
      name: 'More Dependabot actions',
    });
    const recreate = row.getByRole('menuitem', { name: /Recreate/ });
    const [rb, cb, rc] = await Promise.all([
      rebase.boundingBox(),
      chevron.boundingBox(),
      recreate.boundingBox(),
    ]);
    if (!rb || !cb || !rc) throw new Error('missing box');
    // One left edge.
    expect(Math.abs(rc.x - rb.x)).toBeLessThanOrEqual(1);
    // The chevron sits against Rebase's right edge, same top and height.
    expect(Math.abs(cb.x - (rb.x + rb.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(cb.y - rb.y)).toBeLessThanOrEqual(1);
    // No overlaps.
    expect(overlap(rb, cb)).toBe(false);
    expect(overlap(rb, rc)).toBe(false);
    expect(overlap(cb, rc)).toBe(false);
    // The info badge on the locked Rebase button sits clear of the chevron.
    const badge = row.locator('.row-action-locked-hint').first();
    const bb = await badge.boundingBox();
    if (!bb) throw new Error('missing badge');
    expect(overlap(bb, cb)).toBe(false);
    // The reason is said once. Hovering Rebase must not raise a second copy
    // (the bubble) over the note the menu already prints.
    await rebase.hover();
    const shown = await row
      .locator('.row-action-reason, .row-action-note')
      .evaluateAll((els) =>
        els
          .filter(
            (e) =>
              Number(getComputedStyle(e).opacity) > 0.05 &&
              /no action can run until it does/.test(e.textContent ?? ''),
          )
          .map((e) => e.getBoundingClientRect().toJSON()),
      );
    expect(shown).toHaveLength(1);
    for (const b of [rb, cb, rc]) expect(overlap(shown[0], b)).toBe(false);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
