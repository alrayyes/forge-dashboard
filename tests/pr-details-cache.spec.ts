import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The dialog opens with what it read last and swaps in the fresh answer
// without moving any text (#4194).

const NOW = new Date();
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
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
const comment = (id: string, text = `Comment ${id}`) => ({
  id,
  author: { login: 'alice', avatarUrl: '' },
  createdAt: ago(120),
  updatedAt: null,
  ...body(text),
});
const details = (text: string, comments: unknown[] = []) => ({
  description: body(text),
  comments,
  commentCount: comments.length,
  commentsTruncated: false,
  releaseNotes: null,
});
const paragraphs = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix} paragraph ${i}`).join('\n\n');

const pr = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 42,
  title: 'Add structured logging',
  url: 'https://example.com/42',
  author: 'ryankes',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(5),
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
};

async function mockDashboard(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
  await page.route('**/api/v1/dashboard*', (r: Route) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [pr],
        issues: [],
      }),
    }),
  );
}

type Answer = { status?: number; payload?: unknown };

// Each read of the details waits for the test to answer it.
async function holdDetails(page: Page) {
  const waiting: ((a: Answer) => void)[] = [];
  let count = 0;
  await page.route('**/api/v1/pull-requests/details*', (route) => {
    count++;
    return new Promise<void>((resolve) => {
      waiting.push(async (a) => {
        await route.fulfill({
          status: a.status ?? 200,
          contentType: 'application/json',
          body: JSON.stringify(a.payload ?? {}),
        });
        resolve();
      });
    });
  });
  return {
    count: () => count,
    answer: async (a: Answer) => {
      await expect.poll(() => waiting.length).toBeGreaterThan(0);
      waiting.shift()?.(a);
    },
  };
}

const trigger = (page: Page) =>
  page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: /^#\d+ / });
const dialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const box = async (page: Page, sel: string) => {
  const b = await dialog(page).locator(sel).first().boundingBox();
  if (!b) throw new Error(`${sel} has no box`);
  return b;
};
const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
  ).violations;

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 1366, height: 600 },
  { width: 375, height: 667 },
]) {
  test.describe(`details cache at ${viewport.width}px`, () => {
    test.use({ viewport });

    test('first open shows header and status before the answer, then swaps without shifting them', async ({
      page,
    }) => {
      await mockDashboard(page);
      const held = await holdDetails(page);
      await page.goto('/pull-requests.html');
      await trigger(page).click();

      await expect(dialog(page)).toContainText('Add structured logging');
      await expect(dialog(page).locator('.details-skeleton')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      const header = await box(page, '.details-header');
      const footer = await box(page, '.details-footer');

      await held.answer({ payload: details('One short paragraph.') });
      await expect(dialog(page)).toContainText('One short paragraph.');
      const after = await box(page, '.details-header');
      expect(Math.abs(after.y - header.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.height - header.height)).toBeLessThanOrEqual(1);
      // The footer stays where the skeleton left it for a body this short.
      const footerAfter = await box(page, '.details-footer');
      expect(Math.abs(footerAfter.y - footer.y)).toBeLessThanOrEqual(1);
      expect(await axe(page)).toEqual([]);
    });

    test('reopening shows the cached body at once and an equal answer changes no DOM', async ({
      page,
    }) => {
      await mockDashboard(page);
      const held = await holdDetails(page);
      await page.goto('/pull-requests.html');
      const same = details('Same text.', [comment('c1')]);

      await trigger(page).click();
      await held.answer({ payload: same });
      await expect(dialog(page)).toContainText('Same text.');
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();

      await trigger(page).click();
      // The read is still out, and the body is already there.
      await expect(dialog(page)).toContainText('Same text.');
      await expect(dialog(page)).toContainText('Comment c1');
      await expect(dialog(page).locator('.details-skeleton')).toHaveCount(0);
      expect(await axe(page)).toEqual([]);

      await page.evaluate(() => {
        const w = window as unknown as { __mut: number };
        w.__mut = 0;
        const body = document.querySelector('.details-dialog .details-body');
        new MutationObserver((l) => {
          w.__mut += l.length;
        }).observe(body as Node, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      });
      await held.answer({ payload: same });
      await page.waitForTimeout(300);
      expect(
        await page.evaluate(
          () => (window as unknown as { __mut: number }).__mut,
        ),
      ).toBe(0);
      // Nothing changed, so nothing is announced either.
      await expect(dialog(page)).not.toContainText('Details updated.');
      expect(await axe(page)).toEqual([]);
    });

    test('a changed answer swaps in and keeps what the reader is looking at in place', async ({
      page,
    }) => {
      await mockDashboard(page);
      const held = await holdDetails(page);
      await page.goto('/pull-requests.html');
      const long = paragraphs('Old', 40);
      await trigger(page).click();
      await held.answer({ payload: details(long, [comment('c1')]) });
      await expect(dialog(page)).toContainText('Old paragraph 39');
      await page.keyboard.press('Escape');

      await trigger(page).click();
      await expect(dialog(page)).toContainText('Old paragraph 39');
      const bodyEl = dialog(page).locator('.details-body');
      await bodyEl.evaluate((el) => {
        el.scrollTop = el.scrollHeight / 2;
      });
      const probe = dialog(page).getByText('Old paragraph 20', { exact: true });
      const before = (await probe.boundingBox())?.y ?? 0;
      const header = await box(page, '.details-header');

      // New text above the reader, and a new comment below.
      await held.answer({
        payload: details(`${paragraphs('New', 6)}\n\n${long}`, [
          comment('c1'),
          comment('c2'),
        ]),
      });
      await expect(dialog(page)).toContainText('Comment c2');
      await expect(dialog(page)).toContainText('New paragraph 5');
      const after = (await probe.boundingBox())?.y ?? 0;
      expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
      const headerAfter = await box(page, '.details-header');
      expect(Math.abs(headerAfter.y - header.y)).toBeLessThanOrEqual(1);
      await expect(dialog(page)).toContainText('Details updated.');
      expect(await axe(page)).toEqual([]);
    });

    test('a failed refresh keeps the cached body and says it may be old', async ({
      page,
    }) => {
      await mockDashboard(page);
      const held = await holdDetails(page);
      await page.goto('/pull-requests.html');
      await trigger(page).click();
      await held.answer({ payload: details('Kept text.') });
      await expect(dialog(page)).toContainText('Kept text.');
      await page.keyboard.press('Escape');

      await trigger(page).click();
      await expect(dialog(page)).toContainText('Kept text.');
      await expect(dialog(page).locator('.details-older')).toHaveCount(0);
      await held.answer({ status: 500, payload: { error: 'down' } });
      await expect(dialog(page).locator('.details-older')).toBeVisible();
      await expect(dialog(page)).toContainText('Kept text.');
      await expect(dialog(page).locator('.details-error')).toHaveCount(0);
      expect(await axe(page)).toEqual([]);
    });

    test('reports no layout shift for the swap', async ({ page }) => {
      await mockDashboard(page);
      const held = await holdDetails(page);
      await page.goto('/pull-requests.html');
      // The board has settled; only the dialog's own shifts count.
      await expect(trigger(page)).toBeVisible();
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const w = window as unknown as { __cls: number };
        w.__cls = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as PerformanceEntry[] &
            { value: number; hadRecentInput: boolean }[]) {
            if (!e.hadRecentInput) w.__cls += e.value;
          }
        }).observe({ type: 'layout-shift', buffered: false });
      });
      await trigger(page).click();
      await held.answer({ payload: details('Short.') });
      await expect(dialog(page)).toContainText('Short.');
      await page.keyboard.press('Escape');
      await trigger(page).click();
      await held.answer({ payload: details('Short.', [comment('c9')]) });
      await expect(dialog(page)).toContainText('Comment c9');
      await page.waitForTimeout(200);
      const cls = await page.evaluate(
        () => (window as unknown as { __cls: number }).__cls,
      );
      expect(cls).toBeLessThan(0.05);
    });
  });
}

test.describe('hover prefetch', () => {
  test('reads after a 150ms dwell, not when moving across the list', async ({
    page,
  }) => {
    await mockDashboard(page);
    const held = await holdDetails(page);
    await page.goto('/pull-requests.html');
    await trigger(page).hover();
    await expect.poll(() => held.count()).toBe(1);
  });

  test('fires nothing for a pointer that crosses a row and moves on', async ({
    page,
  }) => {
    await mockDashboard(page);
    const held = await holdDetails(page);
    await page.goto('/pull-requests.html');
    const b = await trigger(page).boundingBox();
    if (!b) throw new Error('no trigger');
    await page.mouse.move(b.x + 5, b.y + b.height / 2);
    await page.mouse.move(b.x + 5, b.y - 200);
    await page.waitForTimeout(400);
    expect(held.count()).toBe(0);
  });

  test('a prefetched answer is on screen when the row is opened', async ({
    page,
  }) => {
    await mockDashboard(page);
    const held = await holdDetails(page);
    await page.goto('/pull-requests.html');
    await trigger(page).hover();
    await held.answer({ payload: details('Read early.') });
    await page.waitForTimeout(100);
    await trigger(page).click();
    await expect(dialog(page)).toContainText('Read early.');
    await expect(dialog(page).locator('.details-skeleton')).toHaveCount(0);
    await held.answer({ payload: details('Read early.') });
    expect(await axe(page)).toEqual([]);
  });
});

test.describe('what the dialog keeps and drops', () => {
  const IMAGE = 'https://github.com/user-attachments/assets/shot';
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );

  test('a block with an image stays the same node when only a later paragraph changes', async ({
    page,
  }) => {
    await page.route('**/api/v1/images*', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    await mockDashboard(page);
    const held = await holdDetails(page);
    await page.goto('/pull-requests.html');
    const text = (last: string) => `![shot](${IMAGE})\n\nMiddle.\n\n${last}`;
    await trigger(page).click();
    await held.answer({ payload: details(text('Last one.')) });
    await expect(dialog(page).locator('img.md-image')).toBeVisible();
    await page.keyboard.press('Escape');

    await trigger(page).click();
    const img = dialog(page).locator('img.md-image');
    await expect(img).toBeVisible();
    await expect(img).toHaveClass(/md-image-loaded/);
    await img.evaluate((el) => {
      (el as unknown as { __kept: boolean }).__kept = true;
    });
    await held.answer({ payload: details(text('Last two.')) });
    await expect(dialog(page)).toContainText('Last two.');
    expect(
      await img.evaluate(
        (el) => (el as unknown as { __kept?: boolean }).__kept,
      ),
    ).toBe(true);
  });

  test('closing an issue from the dialog drops what was remembered for it', async ({
    page,
  }) => {
    const issue = {
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 7,
      title: 'The page loses its place',
      url: 'https://example.com/issues/7',
      author: 'ryankes',
      labels: [],
      createdAt: ago(60),
      updatedAt: ago(5),
    };
    await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
    await page.route('**/api/v1/dashboard*', (r: Route) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [forgeHealth('github')],
          pullRequests: [],
          issues: [issue],
        }),
      }),
    );
    let broken = false;
    await page.route('**/api/v1/issues/details*', (r) =>
      broken
        ? r.fulfill({ status: 500, body: '{"error":"down"}' })
        : r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ...details('Old body.'), state: 'open' }),
          }),
    );
    await page.route('**/api/v1/issues/close', (r) =>
      r.fulfill({ status: 204 }),
    );
    await page.goto('/issues.html');
    const row = page.locator('#issue-rows .row').getByRole('button', {
      name: /^#7 /,
    });
    const issueDialog = page.getByRole('dialog', { name: /^Issue details/ });

    await row.click();
    await expect(issueDialog).toContainText('Old body.');
    broken = true;
    await issueDialog.getByRole('button', { name: 'Close issue' }).click();
    await issueDialog
      .getByRole('button', { name: 'Confirm close issue?' })
      .click();
    await expect(issueDialog).toContainText('Closed');
    await page.keyboard.press('Escape');

    await row.click();
    // Nothing from before the close is shown as if it were current.
    await expect(issueDialog).toContainText('Could not load');
    await expect(issueDialog).not.toContainText('Old body.');
  });

  test('what the reader just did is not announced as an update', async ({
    page,
  }) => {
    const issue = {
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 7,
      title: 'The page loses its place',
      url: 'https://example.com/issues/7',
      author: 'ryankes',
      labels: [],
      createdAt: ago(60),
      updatedAt: ago(5),
    };
    await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
    await page.route('**/api/v1/dashboard*', (r: Route) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [forgeHealth('github')],
          pullRequests: [],
          issues: [issue],
        }),
      }),
    );
    let closed = false;
    await page.route('**/api/v1/issues/details*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...details(closed ? 'New body.' : 'Old body.'),
          state: closed ? 'closed' : 'open',
        }),
      }),
    );
    await page.route('**/api/v1/issues/close', (r) => {
      closed = true;
      return r.fulfill({ status: 204 });
    });
    await page.goto('/issues.html');
    await page
      .locator('#issue-rows .row')
      .getByRole('button', { name: /^#7 / })
      .click();
    const issueDialog = page.getByRole('dialog', { name: /^Issue details/ });
    await expect(issueDialog).toContainText('Old body.');
    await issueDialog.getByRole('button', { name: 'Close issue' }).click();
    await issueDialog
      .getByRole('button', { name: 'Confirm close issue?' })
      .click();
    await expect(issueDialog).toContainText('New body.');
    await expect(issueDialog).not.toContainText('Details updated.');
  });

  test('closing and reopening a pull request from the dialog drops what was remembered for it', async ({
    page,
  }) => {
    await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
    await page.route('**/api/v1/dashboard*', (r: Route) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [forgeHealth('github')],
          pullRequests: [{ ...pr, allowedActions: [{ action: 'close' }] }],
          issues: [],
        }),
      }),
    );
    let broken = false;
    await page.route('**/api/v1/pull-requests/details*', (r) =>
      broken
        ? r.fulfill({ status: 500, body: '{"error":"down"}' })
        : r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(details('Old body.')),
          }),
    );
    await page.route('**/api/v1/pull-requests/close', (r) =>
      r.fulfill({ status: 204 }),
    );
    await page.route('**/api/v1/pull-requests/reopen', (r) =>
      r.fulfill({ status: 204 }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    await expect(dialog(page)).toContainText('Old body.');
    broken = true;
    await dialog(page)
      .getByRole('button', { name: 'Close pull request', exact: true })
      .click();
    await dialog(page)
      .getByRole('button', { name: 'Confirm close pull request?', exact: true })
      .click();
    await dialog(page)
      .getByRole('button', { name: 'Reopen pull request' })
      .click();
    await expect(
      dialog(page).getByRole('button', {
        name: 'Close pull request',
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    await trigger(page).click();
    await expect(dialog(page)).toContainText('Could not load');
    await expect(dialog(page)).not.toContainText('Old body.');
  });
});

test('a read already out when the reader closes the pull request is not remembered', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
  await page.route('**/api/v1/dashboard*', (r: Route) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [{ ...pr, allowedActions: [{ action: 'close' }] }],
        issues: [],
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/close', (r) =>
    r.fulfill({ status: 204 }),
  );
  await page.route('**/api/v1/pull-requests/reopen', (r) =>
    r.fulfill({ status: 204 }),
  );
  const held = await holdDetails(page);
  await page.goto('/pull-requests.html');
  await trigger(page).click();
  await held.answer({ payload: details('Old body.') });
  await expect(dialog(page)).toContainText('Old body.');
  await page.keyboard.press('Escape');
  // The reopen shows the cached body while its refresh is still out.
  await trigger(page).click();
  await expect(dialog(page)).toContainText('Old body.');
  await dialog(page)
    .getByRole('button', { name: 'Close pull request', exact: true })
    .click();
  await dialog(page)
    .getByRole('button', { name: 'Confirm close pull request?', exact: true })
    .click();
  await expect(
    dialog(page).getByRole('button', { name: 'Reopen pull request' }),
  ).toBeVisible();
  await dialog(page)
    .getByRole('button', { name: 'Reopen pull request' })
    .click();
  await expect(
    dialog(page).getByRole('button', {
      name: 'Close pull request',
      exact: true,
    }),
  ).toBeVisible();
  // The refresh answers with what it read before the close.
  await held.answer({ payload: details('Read before the close.') });
  await expect(dialog(page)).toContainText('Read before the close.');
  await page.keyboard.press('Escape');
  await trigger(page).click();
  await expect(dialog(page)).not.toContainText('Read before the close.');
});
