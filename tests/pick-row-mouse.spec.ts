import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The owner's report on #4093 after #4095: pressing a choice's name, picture
// or the empty space beside it must tick it, in every pick filter (repo,
// author, label) on every page that has them. These press at page
// coordinates, as a hand does, not through the box: a mouse click on desktop,
// a touch tap on a phone. The tap is the case #4095 missed: a touch moves
// focus after pointerup, so a pointer-held flag was already clear when the
// sheet took focus and the panel closed under the finger.

function pr(repo: string, n: number, author = 'alice') {
  return {
    forge: 'github',
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

const PRS = [
  pr('alrayyes/app', 1, 'alice'),
  pr('alrayyes/lib', 2, 'bob'),
  { ...pr('alrayyes/web', 3, 'alice'), forge: 'forgejo' },
];
const ISSUES = PRS.map((p, i) => ({ ...p, number: 10 + i }));

async function open(
  page: Page,
  which: 'repo' | 'author' | 'label',
  path: string,
) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        forges: [
          { forge: 'github', reachable: true, repoCount: 2 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests: PRS.map((p, i) => ({
          ...p,
          labels: [{ name: i === 0 ? 'bug' : 'docs', color: 'd73a4a' }],
        })),
        issues: ISSUES.map((p, i) => ({
          ...p,
          labels: [{ name: i === 0 ? 'bug' : 'docs', color: 'd73a4a' }],
        })),
        repos: [],
        hiddenDrafts: 0,
      },
    }),
  );
  await page.goto(path);
  await expect(
    page.locator('#shared-repo-filter-button').first(),
  ).toBeAttached();
  const filters = page.getByRole('button', { name: /^Filters/ });
  if (await filters.isVisible()) await filters.click();
  const button = page.locator(`#shared-${which}-filter-button:visible`).first();
  await button.click();
  return button.locator('xpath=..');
}

async function rect(el: Locator) {
  const b = await el.boundingBox();
  if (!b) throw new Error('not laid out');
  return b;
}

const sizes = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone 390', width: 390, height: 844 },
  { name: 'phone 360', width: 360, height: 740 },
] as const;
const kinds = [
  { which: 'repo', first: 'alrayyes/app' },
  { which: 'author', first: 'alice' },
  { which: 'label', first: 'bug' },
] as const;

const pages = ['/pull-requests.html', '/issues.html', '/insights.html'];

for (const size of sizes) {
  for (const kind of kinds) {
    for (const path of pages) {
      test.describe(`${kind.which} row on ${path}, mouse, ${size.name}`, () => {
        test.use({
          viewport: { width: size.width, height: size.height },
          hasTouch: size.name !== 'desktop',
          isMobile: size.name !== 'desktop',
        });
        const spots = ['name', 'image', 'space-right', 'row-left-edge'];
        for (const spot of spots) {
          test(`a real click on the ${spot} ticks it`, async ({ page }) => {
            const host = await open(page, kind.which, path);
            const row = host
              .locator('.label-filter-option', {
                hasText: kind.first,
              })
              .first();
            if (spot === 'image' && !(await row.locator('.pick-image').count()))
              test.skip();
            const r = await rect(row);
            const n = await rect(row.locator('.pick-name'));
            let x = r.x + 2;
            const y = r.y + r.height / 2;
            if (spot === 'name') x = n.x + n.width / 2;
            if (spot === 'image') {
              const i = await rect(row.locator('.pick-image'));
              x = i.x + i.width / 2;
            }
            if (spot === 'space-right') x = r.x + r.width - 6;
            const input = row.getByRole('checkbox');
            if (size.name === 'desktop') await page.mouse.click(x, y);
            else await page.touchscreen.tap(x, y);
            await expect(input).toBeChecked();
            const button = host.locator('.label-filter-button').first();
            // The panel stays open, and the pick is applied: the button no
            // longer reads "All ...".
            await expect(button).toHaveAttribute('aria-expanded', 'true');
            await expect(button).not.toHaveText(/^All /);
          });
        }
        test('Space on the focused row ticks it', async ({ page }) => {
          const host = await open(page, kind.which, path);
          const row = host
            .locator('.label-filter-option', {
              hasText: kind.first,
            })
            .first();
          await row.getByRole('checkbox').focus();
          await page.keyboard.press('Space');
          await expect(row.getByRole('checkbox')).toBeChecked();
        });
      });
    }
  }
}
