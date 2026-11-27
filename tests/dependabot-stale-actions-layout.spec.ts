import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// A Dependabot row while the forge isn't answering: the Rebase split button
// and the Recreate item share one left edge, nothing overlaps, and the row
// prints no copy of the stale note, which is said above the list (#5127). A
// held row says its reason once.
// https://github.com/alrayyes/forge-dashboard/issues/4187

const STALE = {
  code: 'forge_unreachable',
  message:
    "Showing data. The forge isn't answering yet, so this may be an earlier answer, and no action can run until it does.",
};
const HELD = {
  code: 'held',
  message:
    'Runs are held for approval. Approve the workflow runs on the forge first.',
};
const BEHIND = {
  code: 'behind',
  message: 'Behind the base branch',
};

// What the server sends for a stale forge: every action blocked, Merge's
// reason copied into `status`, and no `status.action`. The held case is the
// other way the pair gets locked: only the bot commands are, and the status
// says something else.
const SCENARIOS = {
  stale: {
    status: STALE,
    blocked: { merge: STALE, close: STALE, rebase: STALE, recreate: STALE },
    words: /no action can run until it does/,
  },
  held: {
    status: BEHIND,
    blocked: { merge: BEHIND, close: undefined, rebase: HELD, recreate: HELD },
    words: /Runs are held for approval/,
  },
};
type Scenario = keyof typeof SCENARIOS;

const pr = (scenario: Scenario) => ({
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
  status: SCENARIOS[scenario].status,
  kind: 'dependency',
  allowedActions: [
    { action: 'merge', blocked: SCENARIOS[scenario].blocked.merge },
    { action: 'close', blocked: SCENARIOS[scenario].blocked.close },
    {
      action: 'dependabot_rebase',
      blocked: SCENARIOS[scenario].blocked.rebase,
    },
    {
      action: 'dependabot_recreate',
      blocked: SCENARIOS[scenario].blocked.recreate,
    },
  ],
});

async function open(page: Page, width: number, scenario: Scenario) {
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
        pullRequests: [pr(scenario)],
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

for (const scenario of ['stale', 'held'] as const)
  for (const [name, width] of [
    ['desktop', 1280],
    ['phone', 375],
  ] as const) {
    test(`${scenario}, ${name}: Rebase and Recreate line up and the reason is not repeated`, async ({
      page,
    }, info) => {
      const row = await open(page, width, scenario);
      await row.screenshot({
        path: info.outputPath(`${scenario}-${name}.png`),
      });

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
      // A pair described by the status block has no badge at all.
      const badge = row.locator('.row-action-locked-hint').first();
      if (scenario === 'held') {
        const bb = await badge.boundingBox();
        if (!bb) throw new Error('missing badge');
        expect(overlap(bb, cb)).toBe(false);
      } else {
        await expect(badge).toHaveCount(0);
      }
      // The reason is said once. Hovering Rebase must not raise a second copy
      // (the bubble) over the note the menu already prints.
      await rebase.hover();
      const shown = await row
        .locator('.status-area-message, .row-action-reason, .row-action-note')
        .evaluateAll(
          (els, words) =>
            els
              .filter(
                (e) =>
                  Number(getComputedStyle(e).opacity) > 0.05 &&
                  words.test(e.textContent ?? ''),
              )
              .map((e) => e.getBoundingClientRect().toJSON()),
          SCENARIOS[scenario].words,
        );
      if (scenario === 'stale') {
        expect(shown).toHaveLength(0);
        await expect(row.locator('.earlier-data')).toContainText(
          'Earlier data',
        );
      } else {
        expect(shown).toHaveLength(1);
        for (const b of [rb, cb, rc]) expect(overlap(shown[0], b)).toBe(false);
      }
      // Both buttons are still described by it.
      for (const b of [rebase, recreate]) {
        await expect(b).toHaveAccessibleDescription(SCENARIOS[scenario].words);
      }

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
