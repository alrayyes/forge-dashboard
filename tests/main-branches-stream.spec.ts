import { expect } from '@playwright/test';
import {
  closeStream,
  installFakeStream,
  pushStream,
} from './fake-stream-helper';
import { test } from './server-fixture';

// The Main branches page takes its rows from the dashboard stream. The one
// read of /api/v1/main-branches draws the page first and stands in when the
// stream closes.

function page(subject: string, status: 'failed' | 'passed') {
  const failed = status === 'failed';
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      failed: failed ? 1 : 0,
      passed: failed ? 0 : 1,
      running: 0,
      cancelled: 0,
      awaitingApproval: 0,
      none: 0,
      total: 1,
    },
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    branches: [
      {
        forge: 'github',
        fullName: 'acme/auth-service',
        url: 'https://example.com/acme/auth-service',
        branch: 'main',
        status,
        commit: {
          sha: 'd98f3c2',
          subject,
          author: 'sre-dev',
          committedAt: new Date(Date.now() - 1800_000).toISOString(),
        },
        failingJobs: failed ? ['test'] : [],
        finishedAt: null,
        durationSeconds: null,
        runUrl: 'https://example.com/acme/auth-service/actions/runs/1',
        checks: { passed: 0, running: 0, waiting: 0, failed: failed ? 1 : 0 },
        staleSince: null,
      },
    ],
  };
}

async function open(
  pageUnderTest: import('@playwright/test').Page,
  first: ReturnType<typeof page>,
) {
  const reads: string[] = [];
  let body = first;
  let gate: Promise<void> | null = null;
  await installFakeStream(pageUnderTest);
  await pageUnderTest.route('**/api/v1/main-branches', async (route) => {
    reads.push(route.request().url());
    await gate;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  await pageUnderTest.goto('/');
  return {
    reads,
    answerWith: (next: ReturnType<typeof page>) => {
      body = next;
    },
    // Holds every read until the returned function is called.
    hold: () => {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

test.describe('main branches on the dashboard stream', () => {
  test('a stream message redraws a changed row with no read of its own', async ({
    page: browser,
  }) => {
    const { reads } = await open(browser, page('fix: before', 'failed'));
    await expect(browser.getByText('fix: before')).toBeVisible();

    await pushStream(browser, {
      mainBranchPage: page('fix: after', 'passed'),
    });

    await expect(browser.getByText('fix: after')).toBeVisible();
    await expect(
      browser.getByRole('button', { name: /open pipeline/i }),
    ).toContainText('Passed');
    expect(reads).toHaveLength(1);
  });

  test('with the stream closed the page reads the rows once more', async ({
    page: browser,
  }) => {
    const { reads, answerWith } = await open(
      browser,
      page('fix: before', 'failed'),
    );
    await expect(browser.getByText('fix: before')).toBeVisible();

    answerWith(page('fix: from the read', 'failed'));
    await closeStream(browser);

    await expect(browser.getByText('fix: from the read')).toBeVisible();
    expect(reads).toHaveLength(2);
  });

  test('a late fallback read does not overwrite a newer stream row', async ({
    page: browser,
  }) => {
    const { reads, answerWith, hold } = await open(
      browser,
      page('fix: before', 'failed'),
    );
    await expect(browser.getByText('fix: before')).toBeVisible();

    answerWith(page('fix: stale read', 'failed'));
    const release = hold();
    await closeStream(browser);
    await expect.poll(() => reads.length).toBeGreaterThan(1);

    await pushStream(browser, {
      mainBranchPage: page('fix: from the stream', 'passed'),
    });
    await expect(browser.getByText('fix: from the stream')).toBeVisible();
    release();

    await expect(browser.getByText('fix: from the stream')).toBeVisible();
    await expect(browser.getByText('fix: stale read')).toHaveCount(0);
  });
});
