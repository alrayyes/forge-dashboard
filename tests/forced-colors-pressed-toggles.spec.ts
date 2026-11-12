import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3377 gave the filter pills a pressed mark that forced colors keep. The other
// aria-pressed buttons still say "pressed" by colour or box-shadow alone, which
// forced colors drops: the auto-merge and refs segments, Pause live
// updates and the advisories severity filters. Each needs a border width, an
// outline or a weight. The Settings show-token buttons and the Webhooks
// rebase-bots toggle already swap their text, so they need nothing here.
// https://github.com/alrayyes/forge-dashboard/issues/3388

async function shape(el: Locator) {
  return el.evaluate((node) => {
    const s = getComputedStyle(node);
    return [
      s.outlineStyle,
      s.outlineWidth,
      s.borderTopWidth,
      s.borderTopStyle,
      s.fontWeight,
      s.textDecorationLine,
    ].join('|');
  });
}

async function boxes(els: Locator) {
  return els.evaluateAll((nodes) =>
    nodes.map((el) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10);
    }),
  );
}

async function seedPulls(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [true, false].map((on, i) => ({
          forge: 'github',
          repo: 'acme/app',
          number: i + 1,
          title: `A pull request ${i + 1}`,
          url: `https://example.com/${i + 1}`,
          author: 'someone',
          draft: false,
          ci: 'success',
          mergeStatus: 'mergeable',
          autoMergeEnabled: on,
          labels: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

async function openPulls(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await seedPulls(page);
  await page.goto('/pull-requests.html');
  // Rows are the ready signal: the quick pills are hidden when no pill has a
  // choice to offer (#3669), and these controls don't depend on them.
  await expect(page.locator('#pr-rows .row').first()).toBeVisible();
}

// A phone keeps the segments in the Filters sheet.
async function openSegments(page: Page, width: number) {
  await openPulls(page, width);
  if (width < 600) {
    await page.getByRole('button', { name: /^Filters/ }).click();
    return page.locator('dialog#filter-sheet .am-group button:visible');
  }
  return page.locator('.filter-bar > .am-group button:visible');
}

async function openAdvisories(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  const repo = 'acme/critical';
  const advisory = (n: number, severity: string) => ({
    number: n,
    state: 'open',
    severity,
    summary: `Flaw number ${n}`,
    ghsaId: `GHSA-aaaa-bbbb-${n}`,
    cveId: null,
    package: `pkg-${n}`,
    ecosystem: 'pip',
    scope: 'runtime',
    relationship: 'direct',
    manifestPath: 'requirements.txt',
    openedAt: new Date().toISOString(),
    vulnerableVersions: '< 2.0.0',
    patchedVersion: '2.0.0',
    cvss: null,
    weaknesses: [],
    description: 'Text.',
    references: [],
    url: `https://example.com/${repo}/security/dependabot/${n}`,
  });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/main-branches/advisories*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'known',
        url: `https://example.com/${repo}/security/dependabot`,
        advisories: [advisory(1, 'critical'), advisory(2, 'high')],
      }),
    }),
  );
  await page.route('**/api/v1/main-branches', (route) =>
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
            fullName: repo,
            url: `https://example.com/${repo}`,
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
            runUrl: `https://example.com/${repo}/actions/runs/1`,
            checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
            latestRelease: null,
            staleSince: null,
            advisories: {
              state: 'known',
              count: 2,
              highest: 'critical',
              url: `https://example.com/${repo}/security/dependabot`,
            },
          },
        ],
      }),
    }),
  );
  await page.goto('/');
  await page.getByTestId('main-branch-advisories').click();
  await expect(page.getByTestId('advisories-dialog')).toBeVisible();
  return page.locator('.adv-filter');
}

const CASES: {
  name: string;
  open: (page: Page, width: number) => Promise<Locator>;
}[] = [
  { name: 'auto-merge segment', open: openSegments },
  {
    name: 'Pause live updates',
    open: async (page, width) => {
      await openPulls(page, width);
      return page.locator('#pause-updates-button');
    },
  },
  { name: 'advisories filters', open: openAdvisories },
];

for (const width of [390, 1280]) {
  for (const c of CASES) {
    test(`${c.name} at ${width}px: pressed differs from unpressed under forced colors`, async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: 'active' });
      const controls = await c.open(page, width);
      // Pause is a single button: it is compared with itself, pressed and not.
      const single = (await controls.count()) === 1;
      const pressedSel = page.locator('[aria-pressed="true"]');
      const openSel = page.locator('[aria-pressed="false"]');
      const pick = (sel: Locator) => controls.and(sel).first();

      if (single) {
        const before = await shape(controls);
        await controls.click();
        await expect(controls).toHaveAttribute('aria-pressed', 'true');
        expect(await shape(controls)).not.toBe(before);
      } else {
        await expect(pick(pressedSel)).toBeVisible();
        await expect(pick(openSel)).toBeVisible();
        expect(await shape(pick(pressedSel))).not.toBe(
          await shape(pick(openSel)),
        );
      }

      // Focused, a pressed control still differs from an open one, and the
      // ring keeps its offset.
      await page.keyboard.press('Shift');
      await pick(pressedSel).focus();
      const focusedPressed = await shape(pick(pressedSel));
      await expect(pick(pressedSel)).not.toHaveCSS('outline-offset', '0px');
      if (!single) {
        await pick(openSel).focus();
        expect(await shape(pick(openSel))).not.toBe(focusedPressed);
      }

      // The mark takes no room.
      const withMark = await boxes(controls);
      await page.emulateMedia({ forcedColors: 'none' });
      expect(withMark).toEqual(await boxes(controls));
    });
  }
}
