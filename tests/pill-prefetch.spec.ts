import { expect, type Page } from '@playwright/test';
import { type CheckRow, serveChecks } from './checks-feed-helper';
import { test } from './server-fixture';

// A hover or keyboard focus on the advisories pill starts the list read early
// so a first open is usually ready; a page nobody hovers makes no request, and
// a row whose list the server keeps already makes none either.
// https://github.com/alrayyes/forge-dashboard/issues/4192
// Time is the page's fake clock, so the 120 ms rest and the 8 s grace are
// stepped over rather than waited for.

const REST_MS = 120;
const GRACE_MS = 8_000;

const REPO = 'acme/critical';
const READ_AT = new Date(Date.now() - 4 * 60_000).toISOString();

function branch(warm: boolean) {
  return {
    forge: 'github',
    fullName: REPO,
    url: `https://example.com/${REPO}`,
    branch: 'main',
    status: 'passed',
    commit: {
      sha: 'd98f3c2',
      subject: 'fix: a change',
      author: 'sre-dev',
      committedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
    failingJobs: [],
    finishedAt: null,
    durationSeconds: null,
    runUrl: `https://example.com/${REPO}/actions/runs/1`,
    checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
    latestRelease: null,
    staleSince: null,
    advisories: {
      state: 'known',
      count: 12,
      highest: 'critical',
      url: `https://example.com/${REPO}/security/dependabot`,
      ...(warm ? { listReadAt: READ_AT } : {}),
    },
  };
}

// From here the page's clock moves only when a spec steps it.
async function freeze(page: Page) {
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
}

type Answer = { failing: boolean; gate?: Promise<void> };

async function load(
  page: Page,
  warm: boolean,
  answer: Answer = { failing: false },
) {
  const reads: string[] = [];
  await page.clock.install();
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/main-branches/advisories*', async (route) => {
    reads.push(route.request().url());
    const failing = answer.failing;
    await answer.gate;
    if (failing) return route.fulfill({ status: 502, body: 'bad gateway' });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'known',
        url: `https://example.com/${REPO}/security/dependabot`,
        readAt: READ_AT,
        advisories: [],
      }),
    });
  });
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
        branches: [branch(warm)],
      }),
    }),
  );
  await page.goto('/');
  await expect(page.getByTestId('main-branch-advisories')).toBeVisible();
  await freeze(page);
  return reads;
}

test.describe('advisories pill prefetch (#4192)', () => {
  test('a page nobody hovers makes no advisories request', async ({ page }) => {
    const reads = await load(page, false);
    await page.clock.fastForward(GRACE_MS);
    expect(reads).toEqual([]);
  });

  test('hovering the pill reads the list once, without refresh', async ({
    page,
  }) => {
    const reads = await load(page, false);
    const pill = page.getByTestId('main-branch-advisories');
    await pill.hover();
    await page.clock.fastForward(REST_MS);
    await expect.poll(() => reads.length).toBe(1);
    expect(reads[0]).not.toContain('refresh');
    await page.mouse.move(0, 0);
    await pill.hover();
    await page.clock.fastForward(REST_MS);
    expect(reads.length).toBe(1);
  });

  test('keyboard focus on the pill reads the list', async ({ page }) => {
    const reads = await load(page, false);
    await page.keyboard.press('Tab');
    await page.getByTestId('main-branch-advisories').focus();
    await page.clock.fastForward(REST_MS);
    await expect.poll(() => reads.length).toBe(1);
  });

  test('closing the dialog with Escape does not read the list again', async ({
    page,
  }) => {
    const reads = await load(page, false);
    const pill = page.getByTestId('main-branch-advisories');
    await page.keyboard.press('Tab');
    await pill.focus();
    await page.clock.fastForward(REST_MS);
    await expect.poll(() => reads.length).toBe(1);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    // Open for longer than a repeat is held back, so a fresh read is due.
    await page.clock.fastForward(61_000);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(pill).toBeFocused();
    const before = reads.length;
    await page.clock.fastForward(REST_MS + GRACE_MS);
    expect(reads.length).toBe(before);
  });

  test('Try again after a failed hover read asks the server afresh', async ({
    page,
  }) => {
    let release!: () => void;
    const answer: Answer = {
      failing: true,
      gate: new Promise<void>((r) => (release = r)),
    };
    const reads = await load(page, false, answer);
    const pill = page.getByTestId('main-branch-advisories');
    await pill.hover();
    await page.clock.fastForward(REST_MS);
    await expect.poll(() => reads.length).toBe(1);
    // The dialog opens while the hover's read is still out, then it fails.
    await pill.click();
    answer.failing = false;
    release();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByTestId('advisories-retry').click();
    await expect.poll(() => reads.length).toBe(2);
    await expect(page.getByRole('alert')).toBeHidden();
  });

  test('a pointer that only passes over reads nothing', async ({ page }) => {
    const reads = await load(page, false);
    const pill = page.getByTestId('main-branch-advisories');
    await pill.hover();
    await page.clock.fastForward(REST_MS - 40);
    await page.mouse.move(0, 0);
    await page.clock.fastForward(GRACE_MS);
    expect(reads).toEqual([]);
  });

  test('a row whose list the server keeps already reads nothing', async ({
    page,
  }) => {
    const reads = await load(page, true);
    await page.getByTestId('main-branch-advisories').hover();
    await page.clock.fastForward(GRACE_MS);
    expect(reads).toEqual([]);
  });
});

// The stream takes eight subjects a watch, and the page's own watch uses seven
// of them for the first rows, leaving one for an open dialog. A hover must not
// add to that, or the server answers 400 and every live pill goes down.
const ROWS = 9;

function pipelineRow(n: number) {
  return {
    ...branch(true),
    fullName: `acme/repo-${n}`,
    status: 'failed',
    checks: { passed: 0, running: 0, waiting: 0, failed: 1 },
    runUrl: `https://example.com/acme/repo-${n}/actions/runs/${n}`,
  };
}

test.describe('pipeline pill prefetch (#4192)', () => {
  test('hovering row after row, then opening one, stays within the stream cap', async ({
    page,
  }) => {
    await page.clock.install();
    await page.route('**/api/v1/main-branches', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          counts: {
            failed: ROWS,
            passed: 0,
            running: 0,
            cancelled: 0,
            awaitingApproval: 0,
            none: 0,
            total: ROWS,
          },
          branches: Array.from({ length: ROWS }, (_, i) => pipelineRow(i + 1)),
        }),
      }),
    );
    const stream = await serveChecks(
      page,
      () =>
        [
          {
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            url: '',
            jobId: 1,
          },
        ] as CheckRow[],
    );
    await page.goto('/');
    const pills = page.getByRole('button', { name: /open pipeline/i });
    await expect(pills).toHaveCount(ROWS);
    await stream.idle();
    await expect.poll(() => stream.posts.at(-1)).toBe(7);
    await freeze(page);

    for (const n of [7, 8]) {
      await pills.nth(n).hover();
      await page.clock.fastForward(REST_MS);
    }
    await pills.nth(8).click();
    await expect(page.getByRole('dialog', { name: /pipeline/i })).toBeVisible();
    await page.clock.fastForward(GRACE_MS);
    await stream.idle();

    expect(Math.max(...stream.posts)).toBeLessThanOrEqual(8);
  });

  test('closing the dialog with Escape does not warm the row again', async ({
    page,
  }) => {
    await page.clock.install();
    await page.route('**/api/v1/main-branches', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          counts: {
            failed: ROWS,
            passed: 0,
            running: 0,
            cancelled: 0,
            awaitingApproval: 0,
            none: 0,
            total: ROWS,
          },
          branches: Array.from({ length: ROWS }, (_, i) => pipelineRow(i + 1)),
        }),
      }),
    );
    const stream = await serveChecks(
      page,
      () =>
        [
          {
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            url: '',
            jobId: 1,
          },
        ] as CheckRow[],
    );
    await page.goto('/');
    const pills = page.getByRole('button', { name: /open pipeline/i });
    await expect(pills).toHaveCount(ROWS);
    await expect.poll(() => stream.posts.at(-1)).toBe(7);
    await freeze(page);

    // Reached and opened from the keyboard, as a keyboard user would.
    await page.keyboard.press('Tab');
    await pills.nth(8).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: /pipeline/i })).toBeVisible();
    // Open for longer than a hold lasts, so the row is due a fresh read.
    await page.clock.fastForward(61_000);
    await stream.idle();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /pipeline/i })).toBeHidden();
    await expect(pills.nth(8)).toBeFocused();
    await expect.poll(() => stream.posts.at(-1)).toBe(7);
    const posted = stream.posts.length;
    await page.clock.fastForward(REST_MS + GRACE_MS);
    await stream.idle();
    expect(stream.posts.length).toBe(posted);
    expect(stream.posts.at(-1)).toBe(7);
  });
});
