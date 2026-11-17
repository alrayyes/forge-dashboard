import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #4188: a #N that is a pull request opened an error ("Could not resolve to an
// Issue"), because every unlisted reference was looked up as an issue. The
// issues endpoint now says which kind the number is, and the dialog follows it,
// wherever the reference sits: in a pull request, an issue or a comment.
// https://github.com/alrayyes/forge-dashboard/issues/4188

const REPO = 'alrayyes/forge-dashboard';
const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const body = (text: string) => ({
  text,
  format: 'markdown',
  truncated: false,
  edited: false,
  reactions: noReactions,
});
const comment = (text: string) => ({
  id: '1',
  author: null,
  createdAt: new Date().toISOString(),
  updatedAt: null,
  ...body(text),
});
const thread = (text: string, comments: string[] = []) => ({
  description: body(text),
  comments: comments.map(comment),
  commentCount: comments.length,
  commentsTruncated: false,
});

const now = new Date().toISOString();
const pullRequest = {
  forge: 'github',
  repo: REPO,
  number: 42,
  title: 'Add structured logging',
  url: `https://github.com/${REPO}/pull/42`,
  author: 'claude',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: now,
  updatedAt: now,
  mergeStatus: 'mergeable',
  allowedActions: [{ action: 'merge' }],
};
const issue = {
  forge: 'github',
  repo: REPO,
  number: 12,
  title: 'Logging is noisy',
  url: `https://github.com/${REPO}/issues/12`,
  author: 'claude',
  labels: [],
  createdAt: now,
  updatedAt: now,
};

// What the forge currently says about #4177, changed by a test between opens.
type Served = {
  state: 'open' | 'closed' | 'merged';
  author: { login: string; avatarUrl: string; url: string } | null;
};
const author = {
  login: 'octo-author',
  avatarUrl: '',
  url: 'https://github.com/octo-author',
};
let served: Served = { state: 'merged', author };
test.beforeEach(() => {
  served = { state: 'merged', author };
});

// 4177 is a pull request the board doesn't list, 4100 an issue it doesn't
// list, 9999 neither.
async function open(
  page: Page,
  from: 'pull-requests' | 'issues',
  text: string,
  comments: string[] = [],
  gate: Promise<void> = Promise.resolve(),
) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: now,
        forges: [
          {
            forge: 'github',
            reachable: true,
            repoCount: 1,
            capabilities: { label: 'GitHub' },
          },
        ],
        pullRequests: [pullRequest],
        issues: [issue],
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...thread(text, comments), releaseNotes: null }),
    }),
  );
  await page.route('**/api/v1/issues/details*', async (route: Route) => {
    const number = new URL(route.request().url()).searchParams.get('number');
    if (number === '4177') {
      await gate;

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...thread('The linked change.'),
          kind: 'pullRequest',
          state: 'closed',
          pullRequest: {
            title: 'Add structured logging to the sync loop',
            state: served.state,
            author: served.author,
          },
        }),
      });
    }
    if (number === '5000')
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'the forge could not be reached' }),
      });
    if (number === '9999')
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: issue or pull request not found: #9999 in x/y',
        }),
      });

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...thread(number === '12' ? text : 'An older issue.', comments),
        kind: 'issue',
        state: 'open',
      }),
    });
  });
  await page.goto(`/${from}.html`);
  await page
    .getByRole('button', {
      name: from === 'issues' ? /^#12 / : /^#42 /,
    })
    .click();
}

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });

test.describe('a reference to a pull request opens it (#4188)', () => {
  test('from a pull request body', async ({ page }) => {
    await open(page, 'pull-requests', 'Refs #4177');
    await prDialog(page).getByRole('link', { name: '#4177' }).click();

    await expect(prDialog(page)).toContainText('The linked change.');
    await expect(prDialog(page)).toContainText('#4177');
    await expect(issueDialog(page)).toBeHidden();
    await expect(prDialog(page)).not.toContainText('Could not load');
  });

  test('from an issue body', async ({ page }) => {
    await open(page, 'issues', 'Fixed by #4177');
    await issueDialog(page).getByRole('link', { name: '#4177' }).click();

    await expect(prDialog(page)).toContainText('The linked change.');
    await expect(issueDialog(page)).toBeHidden();
  });

  test('from a comment', async ({ page }) => {
    await open(page, 'issues', 'Body', ['See #4177 for the change.']);
    await issueDialog(page).getByRole('link', { name: '#4177' }).click();

    await expect(prDialog(page)).toContainText('The linked change.');
  });

  test('a reference to an issue still opens an issue', async ({ page }) => {
    await open(page, 'pull-requests', 'Refs #4100');
    await prDialog(page).getByRole('link', { name: '#4100' }).click();

    await expect(issueDialog(page)).toContainText('An older issue.');
    await expect(prDialog(page)).toBeHidden();
  });

  test('a number that is neither says so in plain words', async ({ page }) => {
    await open(page, 'pull-requests', 'Refs #9999');
    await prDialog(page).getByRole('link', { name: '#9999' }).click();

    await expect(issueDialog(page)).toContainText(
      'issue or pull request not found: #9999',
    );
    await expect(issueDialog(page)).not.toContainText(/graphql/i);
  });

  test('a second open of a reference to a pull request is a pull request at once', async ({
    page,
  }) => {
    await open(page, 'issues', 'Fixed by #4177');
    await issueDialog(page).getByRole('link', { name: '#4177' }).click();
    await expect(prDialog(page)).toContainText('The linked change.');
    await page.keyboard.press('Escape');

    // Only what was remembered can say what it is before the read returns.
    await page.evaluate(() => {
      const w = window as unknown as { __labels: string[] };
      w.__labels = [];
      new MutationObserver(() => {
        const d = document.querySelector('dialog.details-dialog[open]');
        const label = d?.getAttribute('aria-label') ?? '';
        if (label.includes('#4177')) w.__labels.push(label);
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label', 'open'],
      });
    });
    await page.getByRole('button', { name: /^#12 / }).click();
    await issueDialog(page).getByRole('link', { name: '#4177' }).click();
    await expect(prDialog(page)).toBeVisible();
    const labels = await page.evaluate(
      () => (window as unknown as { __labels: string[] }).__labels,
    );
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((l) => l.startsWith('Pull request details'))).toBe(
      true,
    );
  });

  for (const width of [360, 1280]) {
    test(`the retargeted dialog has no axe violations at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, 'issues', 'Fixed by #4177');
      await issueDialog(page).getByRole('link', { name: '#4177' }).click();
      await expect(prDialog(page)).toContainText('The linked change.');

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

// The reader sees the real title, who opened it and whether it was merged,
// from the same answer that says it is a pull request.
test.describe('a reference to a pull request the board does not list (#4196)', () => {
  test('shows its real title, author and merged status', async ({ page }) => {
    await open(page, 'issues', 'Fixed by #4177');
    await issueDialog(page).getByRole('link', { name: '#4177' }).click();

    const dialog = prDialog(page);
    await expect(
      dialog.getByRole('heading', {
        name: 'Add structured logging to the sync loop',
      }),
    ).toBeVisible();
    await expect(dialog.getByRole('group', { name: 'Status' })).toHaveText(
      'Merged',
    );
    await expect(dialog.locator('.details-author')).toContainText(
      'Opened by octo-author',
    );
    await expect(
      dialog.locator('.details-author').getByRole('link'),
    ).toHaveAttribute('href', 'https://github.com/octo-author');
    await expect(dialog).not.toContainText('Pull request #4177');
  });

  test('a pull request in the list opens as the normal dialog with no extra request', async ({
    page,
  }) => {
    const extra: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/v1\/issues\/details/.test(r.url())) extra.push(r.url());
    });
    await open(page, 'pull-requests', 'Refs #42');
    await prDialog(page).getByRole('link', { name: '#42' }).click();

    await expect(prDialog(page).locator('.details-state')).toBeVisible();
    await expect(prDialog(page)).toContainText('Add structured logging');
    expect(extra).toEqual([]);
  });

  test('keeps the issue-style shell with the reason when the read fails', async ({
    page,
  }) => {
    await open(page, 'issues', 'Fixed by #5000');
    await issueDialog(page).getByRole('link', { name: '#5000' }).click();

    await expect(issueDialog(page)).toContainText(
      'the forge could not be reached',
    );
    await expect(prDialog(page)).toBeHidden();
  });

  for (const size of [
    { width: 1366, height: 600 },
    { width: 375, height: 667 },
    { width: 1280, height: 900 },
  ]) {
    test(`the header does not move when the real details arrive at ${size.width}x${size.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await open(page, 'issues', 'Fixed by #4177', [], gate);
      await issueDialog(page).getByRole('link', { name: '#4177' }).click();

      const spots = (dialog: ReturnType<typeof prDialog>) =>
        dialog.evaluate((el) => {
          const top = (sel: string) =>
            el.querySelector(sel)?.getBoundingClientRect().top ?? null;
          return {
            dialog: el.getBoundingClientRect().top,
            ref: top('.details-ref'),
            title: top('.details-title'),
            close: top('.details-close'),
          };
        });
      const shell = page.getByRole('dialog', { name: /#4177/ });
      await expect(shell).toBeVisible();
      await expect(shell.locator('.details-skeleton')).toBeVisible();
      const before = await spots(shell);
      // Every change to the page on the way, not only where it ends up.
      await page.evaluate(() => {
        const w = window as unknown as { __refTops: number[] };
        w.__refTops = [];
        new MutationObserver(() => {
          const top = document
            .querySelector('dialog.details-dialog[open] .details-ref')
            ?.getBoundingClientRect().top;
          if (top !== undefined) w.__refTops.push(top);
        }).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      });
      release();
      await expect(
        prDialog(page).getByRole('heading', {
          name: 'Add structured logging to the sync loop',
        }),
      ).toBeVisible();
      await expect(prDialog(page).locator('.details-skeleton')).toBeHidden();
      const after = await spots(prDialog(page));

      const tops = await page.evaluate(
        () => (window as unknown as { __refTops: number[] }).__refTops,
      );
      expect(tops.length).toBeGreaterThan(0);
      for (const top of tops)
        expect(Math.abs(top - (before.ref ?? 0))).toBeLessThanOrEqual(1);
      for (const key of ['dialog', 'ref', 'title', 'close'] as const)
        expect(
          Math.abs((after[key] ?? 0) - (before[key] ?? 0)),
          `${key} moved`,
        ).toBeLessThanOrEqual(1);
    });
  }

  test('a deleted account has no byline and nothing throws', async ({
    page,
  }) => {
    served = { state: 'closed', author: null };
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await open(page, 'issues', 'Fixed by #4177');
    await issueDialog(page).getByRole('link', { name: '#4177' }).click();

    const dialog = prDialog(page);
    await expect(dialog.getByRole('group', { name: 'Status' })).toHaveText(
      'Closed',
    );
    await expect(dialog.locator('.details-author')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a second open shows what the forge says now, without the header moving', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 600 });
    served = { state: 'open', author };
    let reads = 0;
    page.on('request', (r) => {
      if (
        r.url().includes('/api/v1/issues/details') &&
        r.url().includes('number=4177')
      )
        reads++;
    });
    await open(page, 'issues', 'Fixed by #4177');
    await issueDialog(page).getByRole('link', { name: '#4177' }).click();
    const dialog = prDialog(page);
    await expect(dialog.getByRole('group', { name: 'Status' })).toHaveText(
      'Open',
    );
    const refTop = () =>
      dialog
        .locator('.details-ref')
        .evaluate((el) => el.getBoundingClientRect().top);
    const first = await refTop();
    await page.keyboard.press('Escape');

    // Merged by someone else while the dialog was closed.
    served = { state: 'merged', author };
    await page.evaluate(() => {
      const w = window as unknown as { __refTops: number[] };
      w.__refTops = [];
      new MutationObserver(() => {
        const top = document
          .querySelector('dialog.details-dialog[open] .details-ref')
          ?.getBoundingClientRect().top;
        if (top !== undefined) w.__refTops.push(top);
      }).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    });
    await page.getByRole('button', { name: /^#12 / }).click();
    await issueDialog(page).getByRole('link', { name: '#4177' }).click();

    await expect(dialog.getByRole('group', { name: 'Status' })).toHaveText(
      'Merged',
    );
    expect(reads).toBe(2);
    const tops = await page.evaluate(
      () => (window as unknown as { __refTops: number[] }).__refTops,
    );
    expect(tops.length).toBeGreaterThan(0);
    for (const top of [...tops, await refTop()])
      expect(Math.abs(top - first)).toBeLessThanOrEqual(1);
  });

  for (const width of [360, 1280]) {
    test(`the real details have no axe violations at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, 'issues', 'Fixed by #4177');
      await issueDialog(page).getByRole('link', { name: '#4177' }).click();
      await expect(
        prDialog(page).getByRole('heading', {
          name: 'Add structured logging to the sync loop',
        }),
      ).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
