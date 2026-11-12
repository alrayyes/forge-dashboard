import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// #3693: on a phone the Filters sheet lays the Refs segment out as one
// broken pill and draws each picker in its own style. Mocks the dashboard
// snapshot only.

const REPO = 'acme/app';
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const issues = [1, 2, 3].map((n) => ({
  forge: 'github',
  repo: `acme/app${n % 2}`,
  number: n,
  title: `Issue ${n}`,
  url: `https://example.com/issues/${n}`,
  author: n % 2 ? 'alrayyes' : 'claude',
  labels: [{ name: n % 2 ? 'bug' : 'docs', color: 'ededed' }],
  createdAt: ago(n),
  updatedAt: ago(n),
  linkedPullRequests: [],
  referencedByPullRequests:
    n === 2
      ? [
          {
            repo: `acme/app${n % 2}`,
            number: 9,
            forge: 'github',
            draft: false,
            pageUrl: '/pull-requests.html?pr=github/acme/app0/9',
            ci: 'success',
            checks: { passed: 1, running: 0, waiting: 0, failed: 0 },
            awaitingWorkflowApproval: false,
          },
        ]
      : [],
  mentionedByPullRequests: [],
}));
const prs = [1, 2, 3, 4, 5].map((n) => ({
  forge: 'github',
  repo: `acme/app${n % 2}`,
  number: n,
  title: `Pull request ${n}`,
  url: `https://example.com/pull/${n}`,
  author:
    n === 4
      ? 'dependabot'
      : n === 5
        ? 'release-please[bot]'
        : n % 2
          ? 'alrayyes'
          : 'claude',
  draft: false,
  ci: n === 3 ? 'failure' : 'success',
  labels: [{ name: n % 2 ? 'bug' : 'docs', color: 'ededed' }],
  createdAt: ago(n),
  updatedAt: ago(n),
  mergeStatus: 'blocked',
  behind: false,
  kind: n === 4 ? 'dependency' : n === 5 ? 'release' : 'regular',
  closesIssues: [],
  refsIssues:
    n === 2
      ? [
          {
            repo: `acme/app0`,
            number: 2,
            relation: 'refs',
            tracked: true,
            url: 'https://example.com/i/2',
            pageUrl: '/issues.html?issue=github/acme/app0/2',
          },
        ]
      : [],
  mentionsIssues: [],
}));
void REPO;

async function open(
  page: Page,
  path: string,
  size: { width: number; height: number },
) {
  await page.setViewportSize(size);
  await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
        pullRequests: prs,
        issues,
        openIssueCount: issues.length,
        repos: [],
        hiddenDrafts: 0,
        navCounts: navCountsFor(prs as never, issues.length),
      }),
    }),
  );
  await page.goto(path);
  await expect(page.locator('.row').first()).toBeVisible();
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.locator('dialog#filter-sheet')).toBeVisible();
}

const sizes = [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
];
const pages = [
  '/issues.html',
  '/pull-requests.html',
  '/bots.html',
  '/releases.html',
];

for (const size of sizes) {
  for (const path of pages) {
    test(`${path} Filters sheet at ${size.width}px: one picker style, a fitting Refs segment, 44px buttons (#3693)`, async ({
      page,
    }) => {
      await open(page, path, size);
      const m = await page.evaluate(() => {
        const sheet = document.querySelector(
          'dialog#filter-sheet',
        ) as HTMLElement;
        const rect = (el: Element) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right };
        };
        const pickers = [
          ...sheet.querySelectorAll<HTMLElement>(
            'select.col-filter, select.group-select, .label-filter-button',
          ),
        ]
          .filter((el) => el.offsetParent !== null)
          .map((el) => {
            const cs = getComputedStyle(el);
            return {
              name: el.getAttribute('aria-label') ?? el.id,
              h: el.getBoundingClientRect().height,
              paddingLeft: cs.paddingLeft,
              paddingRight: cs.paddingRight,
              arrow: cs.backgroundImage,
              appearance: cs.appearance,
            };
          });
        const seg = sheet.querySelector('.refs-group');
        const segInfo = seg
          ? {
              box: rect(seg),
              buttons: [...seg.querySelectorAll('button')]
                .filter((b) => b.offsetParent !== null)
                .map((b) => ({
                  ...rect(b),
                  text: b.textContent ?? '',
                  name: b.getAttribute('aria-label') ?? '',
                  title: b.title,
                })),
              label: rect(seg.querySelector('.am-label') as Element),
            }
          : null;
        const foot = ['filter-sheet-show', 'filter-sheet-clear'].map((id) => {
          const el = document.getElementById(id) as HTMLElement;
          return { id, h: el.getBoundingClientRect().height };
        });
        return { pickers, segInfo, foot, sheet: rect(sheet) };
      });
      console.log(JSON.stringify({ path, size: size.width, m }));

      expect(m.pickers.length).toBeGreaterThan(3);
      for (const p of m.pickers) {
        expect(p.h, p.name).toBeGreaterThanOrEqual(44);
        expect(p.paddingLeft, p.name).toBe(m.pickers[0].paddingLeft);
        expect(p.paddingRight, p.name).toBe(m.pickers[0].paddingRight);
        expect(p.arrow, p.name).toBe(m.pickers[0].arrow);
        expect(p.arrow, p.name).toContain('linear-gradient');
      }

      // Bots and Releases hide the segment when nothing there references an
      // issue (#3669), so only a drawn one is measured.
      if (m.segInfo && m.segInfo.box.w > 0) {
        // Every choice sits inside the outline, and none shares a line with
        // another unless the whole segment fits on one line.
        const { box, buttons } = m.segInfo;
        for (const b of buttons) {
          expect(b.w).toBeGreaterThan(0);
          expect(b.x).toBeGreaterThanOrEqual(box.x);
          expect(b.right).toBeLessThanOrEqual(box.right + 0.5);
          expect(b.h).toBeGreaterThanOrEqual(44);
        }
        // Compact: Any and both choices share one row, with short visible
        // text and the full wording in the name (label in name).
        expect(buttons.length).toBeGreaterThanOrEqual(2);
        expect(new Set(buttons.map((b) => Math.round(b.y))).size).toBe(1);
        expect(box.h).toBeLessThanOrEqual(52);
        for (const b of buttons.slice(1)) {
          expect(b.name.toLowerCase()).toContain(b.text.toLowerCase());
          expect(b.title.length).toBeGreaterThan(b.text.length);
        }
        expect(box.right).toBeLessThanOrEqual(size.width);
      }

      // Show N results and Clear all: the same 44px target, no taller.
      for (const f of m.foot) expect(f.h, f.id).toBe(44);

      const results = await new AxeBuilder({ page })
        .include('dialog#filter-sheet')
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}

test('keyboard focus follows the visual order and shows a ring in the Issues sheet (#3693)', async ({
  page,
}) => {
  await open(page, '/issues.html', sizes[0]);
  const refs = page.locator('dialog#filter-sheet .refs-group button');
  const ys: number[] = [];
  for (let i = 0; i < 3; i++) {
    await refs.nth(i).focus();
    await page.keyboard.press('Tab'); // moves on; refocus below for the ring
    await refs.nth(i).focus();
    const ring = await refs.nth(i).evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
    });
    expect(ring).toBe(true);
    ys.push((await refs.nth(i).boundingBox())?.y ?? 0);
  }
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
});
