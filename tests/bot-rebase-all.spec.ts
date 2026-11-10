import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Bots page header asks every listed, out-of-date bot pull request to
// rebase through the per-row actions. The plan (who counts, the labels) is
// pinned in bot-rebase-all.test.ts; these cases pin the wiring: the header,
// the confirm dialog, the requests made and a refusal staying on its row.

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Bump dependency ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'dependabot[bot]',
    draft: false,
    ci: 'pending',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    allowedActions: [{ action: 'dependabot_rebase' }],
    ...overrides,
  };
}

const renovate = (number: number) =>
  pr(number, {
    forge: 'forgejo',
    repo: 'acme/site',
    author: 'renovate[bot]',
    allowedActions: [{ action: 'renovate_rebase' }],
  });

async function open(page: Page, pullRequests: unknown[], forges?: unknown[]) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route(/\/api\/v1\/dashboard(\/refresh)?(\?.*)?$/, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: forges ?? [
          { forge: 'github', reachable: true, repoCount: 1 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  for (const endpoint of ['dependabot-action', 'renovate-rebase']) {
    await page.route(`**/api/v1/pull-requests/${endpoint}`, (route: Route) => {
      const body = route.request().postDataJSON();
      posts.push({ url: route.request().url(), body });
      if (body.number === 3) {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Not rebasable',
            code: 'not_mergeable',
            message: 'The pull request is not rebasable.',
          }),
        });
      }
      return route.fulfill({ status: 204 });
    });
  }
  await page.goto('/bots.html');
  return posts;
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test('Rebase all counts the rows behind and asks each bot to rebase', async ({
  page,
}) => {
  const posts = await open(page, [
    pr(1),
    pr(2),
    renovate(4),
    pr(5, { behind: false }),
  ]);
  const button = page.getByRole('button', { name: 'Rebase all (3)' });
  await expect(button).toBeVisible();
  await expect(page.getByText('3 of 4 are out of date.')).toBeVisible();

  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Rebase 3 pull requests?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('listitem')).toHaveCount(3);
  await expectNoAxeViolations(page);

  await dialog.getByRole('button', { name: 'Rebase', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => posts.length).toBe(3);
  expect(
    posts.map((p) => [p.url.split('/').pop(), p.body.number]).sort(),
  ).toEqual([
    ['dependabot-action', 1],
    ['dependabot-action', 2],
    ['renovate-rebase', 4],
  ]);
  expect(posts.find((p) => p.body.number === 1)?.body.action).toBe('rebase');
  await expect(
    page.getByRole('button', { name: 'Rebase all' }),
  ).toHaveAttribute('aria-disabled', 'true');
});

test('Cancel in the dialog asks for nothing', async ({ page }) => {
  const posts = await open(page, [pr(1)]);
  await page.getByRole('button', { name: 'Rebase all (1)' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(posts).toEqual([]);
});

test('a refused request stays on its row and the others go through', async ({
  page,
}) => {
  const posts = await open(page, [pr(1), pr(3), pr(2)]);
  await page.getByRole('button', { name: 'Rebase all (3)' }).click();
  await page.getByRole('button', { name: 'Rebase', exact: true }).click();
  await expect.poll(() => posts.length).toBe(3);
  const refused = page.locator('#pr-rows > .row', {
    hasText: 'Bump dependency 3',
  });
  await expect(refused).toContainText('not rebasable');
  await expect(page.locator('#rebase-all-status')).toHaveText(
    'Rebase requested for 2 of 3. 1 failed.',
  );
});

test('Rebase all shows only while something is out of date', async ({
  page,
}) => {
  await open(page, [pr(1, { behind: false }), renovate(4)]);
  const button = page.locator('#rebase-all-button');
  await expect(button).toBeVisible();
  await expectNoAxeViolations(page);

  // The filter hides the one row that is behind, while the button has focus.
  await button.focus();
  await page
    .locator('.quick-pill.forge-pill[data-pill="github"]')
    .evaluate((el) => {
      (el as HTMLElement).click();
    });
  await expect(button).toBeHidden();
  await expect(page.locator('#rebase-all-summary')).toBeHidden();
  await expect(
    page.locator('.filter-bar .quick-pills .quick-pill[data-pill="all"]'),
  ).toBeFocused();
  await expectNoAxeViolations(page);

  await page
    .locator('.filter-bar .quick-pills .quick-pill[data-pill="all"]')
    .click();
  await expect(button).toBeVisible();
});

test('Rebase all is hidden from the moment it is rendered', async ({
  page,
}) => {
  // Watch the block land in the DOM, before the first snapshot decides.
  await page.addInitScript(() => {
    const seen: boolean[] = [];
    (window as unknown as { rebaseAllHidden: boolean[] }).rebaseAllHidden =
      seen;
    new MutationObserver(() => {
      const block = document.querySelector<HTMLElement>('.rebase-all');
      if (block && seen.length === 0) seen.push(block.hidden === true);
    }).observe(document, { childList: true, subtree: true });
  });
  await open(page, [pr(1, { behind: false })]);
  await expect(page.locator('#rebase-all-button')).toBeAttached();
  const seen = await page.evaluate(
    () => (window as unknown as { rebaseAllHidden: boolean[] }).rebaseAllHidden,
  );
  expect(seen).toEqual([true]);
  await expect(page.locator('#rebase-all-button')).toBeHidden();
  await expectNoAxeViolations(page);
});

test('Rebase all shows its progress through a run, then goes', async ({
  page,
}) => {
  const rows = [pr(1), pr(2)];
  await open(page, rows);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/v1/pull-requests/dependabot-action',
    async (route) => {
      await held;
      await route.fulfill({ status: 204 });
    },
  );
  await page.getByRole('button', { name: 'Rebase all (2)' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Rebase', exact: true })
    .click();
  await expect(page.locator('#rebase-all-button')).toHaveText(
    'Rebasing 0 of 2',
  );

  await expectNoAxeViolations(page);

  release();
  await expect(page.locator('#rebase-all-status')).toHaveText(
    'Rebase requested for 2.',
  );

  // The snapshot that follows finds nothing behind: no reload needed.
  for (const row of rows) row.behind = false;
  await page.locator('#force-refresh-button').click();
  await expect(page.locator('#rebase-all-button')).toBeHidden();
});

test('Dependabot rows on a GitHub App with no token are not counted', async ({
  page,
}) => {
  await open(
    page,
    [pr(1), renovate(4)],
    [
      {
        forge: 'github',
        reachable: true,
        repoCount: 1,
        dependabotCommandsBlocked: 'Dependabot needs a personal token.',
      },
      { forge: 'forgejo', reachable: true, repoCount: 1 },
    ],
  );
  await expect(
    page.getByRole('button', { name: 'Rebase all (1)' }),
  ).toBeVisible();
  await expect(
    page.getByText('Dependabot needs a personal token.').first(),
  ).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the header and dialog fit a phone in ${scheme} and pass axe`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 360, height: 800 });
    await open(page, [pr(1), renovate(4)]);
    await page.getByRole('button', { name: 'Rebase all (2)' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoAxeViolations(page);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
}

// The summary line and its button sit inside the card's own padding (#3246):
// the sentence starts where the heading does, the button ends 18px inside the
// card's right edge, and 12px separates the block from the header rule and
// from the first row, measured to the content (the strip's own padding).
for (const width of [390, 1280]) {
  test(`the Rebase all block sits inside the card padding at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, [pr(1), pr(2)]);
    const button = page.locator('#rebase-all-button');
    await expect(button).toBeVisible();
    const m = await page.evaluate(() => {
      const r = (el: Element | null) => el!.getBoundingClientRect();
      const card = document.querySelector('section.board')!;
      const summary = document.getElementById('rebase-all-summary')!;
      const button = document.getElementById('rebase-all-button')!;
      // The strip's own box, less its padding: the chips and the stacked
      // phone layout move the content, but the insets stay 12px and 18px.
      const block = document.querySelector('.rebase-all')!;
      const pad = getComputedStyle(block);
      return {
        headingLeft: r(card.querySelector('.board-head h2')).left,
        headBottom: r(card.querySelector('.board-head')).bottom,
        cardInnerRight: r(card).right - card.clientLeft,
        summaryLeft: r(summary).left,
        buttonRight: r(button).right,
        blockTop: r(block).top + Number.parseFloat(pad.paddingTop),
        blockBottom: r(block).bottom - Number.parseFloat(pad.paddingBottom),
        rowTop: r(document.querySelector('#pr-rows > .row')).top,
        buttonMinHeight: getComputedStyle(button).minHeight,
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
      };
    });
    expect(m.summaryLeft).toBeCloseTo(m.headingLeft, 0);
    expect(m.cardInnerRight - m.buttonRight).toBeCloseTo(18, 0);
    expect(m.blockTop - m.headBottom).toBeCloseTo(12, 0);
    expect(m.rowTop - m.blockBottom).toBeCloseTo(12, 0);
    expect(m.buttonMinHeight).toBe('44px');
    expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
  });
}

// The summary as a status strip (#3276): a headline, an optional reason line,
// three count chips and the button. The chips repeat the headline's numbers for
// scanning, so they sit outside the element the button's aria-describedby
// reads.
const chipTexts = (page: Page) =>
  page.locator('.rebase-all-chips > li').allInnerTexts();

test('the strip shows the counts as chips beside the headline', async ({
  page,
}) => {
  await open(page, [pr(1), pr(2)]);
  await expect(page.locator('.rebase-all-chips > li')).toHaveText([
    '2 out of date',
    '0 failing',
    '2 ready to rebase',
  ]);
  await expect(page.locator('.rebase-all-headline')).toHaveText(
    '2 of 2 are out of date.',
  );
  await expect(page.locator('#rebase-all-summary')).toContainText(
    '2 of 2 are out of date.',
  );
  // The chips repeat the counts, so the description leaves them out.
  await expect(
    page.locator('#rebase-all-summary .rebase-all-chips'),
  ).toHaveCount(0);
  await expect(page.locator('#rebase-all-button')).toHaveAttribute(
    'aria-describedby',
    'rebase-all-summary',
  );
});

test('the chips count the rows the filters leave, not held CI or waiting requests', async ({
  page,
}) => {
  const posts = await open(
    page,
    [
      // A: out of date and rebasable.
      renovate(1),
      // B: out of date, on a forge that refuses Dependabot commands.
      pr(2),
      // C: current, failing.
      pr(3, { behind: false, ci: 'failure', failingCi: true }),
      // D: current, failing only for a workflow held for approval.
      pr(4, { behind: false, ci: 'failure', failingCi: false }),
      // E: out of date, a rebase already asked for below.
      pr(5, {
        forge: 'forgejo',
        repo: 'acme/site',
        author: 'renovate[bot]',
        allowedActions: [{ action: 'renovate_rebase', primary: true }],
      }),
    ],
    [
      {
        forge: 'github',
        reachable: true,
        repoCount: 1,
        dependabotCommandsBlocked: 'Dependabot needs a personal token.',
      },
      { forge: 'forgejo', reachable: true, repoCount: 1 },
    ],
  );
  await page
    .locator('#pr-rows > .row', { hasText: 'Bump dependency 5' })
    .getByRole('button', { name: 'Renovate: Rebase' })
    .click();
  await expect.poll(() => posts.length).toBe(1);
  await expect(page.locator('.rebase-all-chips > li')).toHaveText([
    '3 out of date',
    '1 failing',
    '1 ready to rebase',
  ]);
  expect(posts).toHaveLength(1);
});

test('the reason is its own line and a narrower view narrows every chip', async ({
  page,
}) => {
  await open(
    page,
    [pr(1), renovate(4)],
    [
      {
        forge: 'github',
        reachable: true,
        repoCount: 1,
        dependabotCommandsBlocked: 'Dependabot needs a personal token.',
      },
      { forge: 'forgejo', reachable: true, repoCount: 1 },
    ],
  );
  const reason = page.locator('.rebase-all-reason');
  await expect(reason).toHaveText('Dependabot needs a personal token.');
  await expect(
    page.locator('#rebase-all-summary').locator('.rebase-all-reason'),
  ).toHaveCount(1);
  await expect(page.locator('.rebase-all-chips > li')).toHaveText([
    '2 out of date',
    '0 failing',
    '1 ready to rebase',
  ]);
  await page
    .locator('.quick-pill.forge-pill[data-pill="github"]')
    .evaluate((el) => {
      (el as HTMLElement).click();
    });
  await expect(page.locator('.rebase-all-chips > li')).toHaveText([
    '1 out of date',
    '0 failing',
    '0 ready to rebase',
  ]);
});

test('with nothing rebasable the reason sits under the headline and the button says why', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const reason =
    'Dependabot commands need a personal token on this forge, so these pull requests cannot be asked to rebase from here, and this sentence is long enough to wrap.';
  await open(
    page,
    [pr(1)],
    [
      {
        forge: 'github',
        reachable: true,
        repoCount: 1,
        dependabotCommandsBlocked: reason,
      },
    ],
  );
  const button = page.locator('#rebase-all-button');
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(button).toHaveAttribute(
    'aria-describedby',
    'rebase-all-summary',
  );
  await expect(page.locator('.rebase-all-reason')).toHaveText(reason);
  const m = await page.evaluate(() => {
    const r = (el: Element | null) => el!.getBoundingClientRect();
    const card = document.querySelector('section.board')!;
    const reason = document.querySelector('.rebase-all-reason')!;
    const headline = document.querySelector('.rebase-all-headline')!;
    return {
      headlineBottom: r(headline).bottom,
      reasonTop: r(reason).top,
      reasonLeft: r(reason).left,
      reasonRight: r(reason).right,
      cardLeft: r(card).left,
      cardRight: r(card).right,
      color: getComputedStyle(reason).color,
      ink2: getComputedStyle(document.documentElement)
        .getPropertyValue('--ink-2')
        .trim(),
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    };
  });
  expect(m.reasonTop).toBeGreaterThanOrEqual(m.headlineBottom);
  expect(m.reasonLeft - m.cardLeft).toBeGreaterThanOrEqual(18);
  expect(m.cardRight - m.reasonRight).toBeGreaterThanOrEqual(18);
  expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
  await expectNoAxeViolations(page);
});

test('on a phone the chips keep their words and the button fills the strip', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, [pr(1), pr(2)]);
  await expect(page.locator('.rebase-all-chips > li')).toHaveCount(3);
  expect(await chipTexts(page)).toEqual([
    '2 out of date',
    '0 failing',
    '2 ready to rebase',
  ]);
  const m = await page.evaluate(() => {
    const r = (el: Element) => el.getBoundingClientRect();
    const block = document.querySelector('.rebase-all')!;
    const button = document.getElementById('rebase-all-button')!;
    const style = getComputedStyle(block);
    const left =
      r(block).left + Number.parseFloat(style.paddingLeft) + block.clientLeft;
    const right =
      r(block).right - Number.parseFloat(style.paddingRight) - block.clientLeft;
    return {
      buttonLeft: r(button).left,
      buttonRight: r(button).right,
      buttonHeight: r(button).height,
      left,
      right,
      chipLines: [...document.querySelectorAll('.rebase-all-chips > li')].map(
        (li) => Math.round(r(li).height),
      ),
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    };
  });
  expect(m.buttonLeft).toBeCloseTo(m.left, 0);
  expect(m.buttonRight).toBeCloseTo(m.right, 0);
  expect(m.buttonHeight).toBeGreaterThanOrEqual(44);
  // A chip is one line tall: its words never break mid-word.
  expect(Math.max(...m.chipLines)).toBeLessThan(40);
  expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
});

test('the chip list is hidden with the strip', async ({ page }) => {
  await open(page, [pr(1, { behind: false })]);
  await expect(page.locator('.rebase-all-chips')).toBeHidden();
  await expect(page.locator('.rebase-all')).toBeHidden();
});

test('the chips follow a run, one snapshot at a time', async ({ page }) => {
  const rows = [pr(1), pr(2)];
  await open(page, rows);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/v1/pull-requests/dependabot-action',
    async (route) => {
      await held;
      await route.fulfill({ status: 204 });
    },
  );
  await page.getByRole('button', { name: 'Rebase all (2)' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Rebase', exact: true })
    .click();
  await expect(page.locator('#rebase-all-button')).toHaveText(
    'Rebasing 0 of 2',
  );
  await expect(page.locator('.rebase-all-chips')).toBeVisible();
  await expect(page.locator('.rebase-all-chips > li')).toHaveText([
    '2 out of date',
    '0 failing',
    // Requests go one after another, so 0 or 1 are still left to ask.
    /^[01] ready to rebase$/,
  ]);
  release();
  await expect(page.locator('#rebase-all-status')).toHaveText(
    'Rebase requested for 2.',
  );
  for (const row of rows) row.behind = false;
  await page.locator('#force-refresh-button').click();
  await expect(page.locator('.rebase-all')).toBeHidden();
  await expect(page.locator('.rebase-all-chips')).toBeHidden();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the strip passes axe in ${scheme} with every chip tint`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, [
      pr(1),
      pr(2, { behind: false, ci: 'failure', failingCi: true }),
    ]);
    await expect(page.locator('.rebase-all-chips > li')).toHaveText([
      '1 out of date',
      '1 failing',
      '1 ready to rebase',
    ]);
    await expectNoAxeViolations(page);
  });

  test(`the strip passes axe in ${scheme} with zero chips`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(
      page,
      [pr(1)],
      [
        {
          forge: 'github',
          reachable: true,
          repoCount: 1,
          dependabotCommandsBlocked: 'Dependabot needs a personal token.',
        },
      ],
    );
    await expect(page.locator('.rebase-all-chips > li')).toHaveText([
      '1 out of date',
      '0 failing',
      '0 ready to rebase',
    ]);
    await expectNoAxeViolations(page);
  });
}
