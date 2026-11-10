import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// Insights and Webhooks drew their empty-data text ("0 repositories tracked",
// "No open pull requests.", "Nothing tracked yet") while the first dashboard
// read was still pending. They now draw the Pull requests/Issues skeleton,
// aria-busy and a polite status, and the empty text only after a read that
// answered with zero records. https://github.com/alrayyes/forge-dashboard/issues/3367

const isRead = (url: string) => new URL(url).pathname === '/api/v1/dashboard';

const EMPTY = {
  readIntervalSeconds: 600,
  firstRefreshDone: true,
  forges: [{ forge: 'github', reachable: true, repoCount: 0 }],
  repos: [],
  pullRequests: [],
  issues: [],
};

const FULL = {
  ...EMPTY,
  forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
  repos: [
    { forge: 'github', fullName: 'acme/web', hasWebhook: true },
    { forge: 'github', fullName: 'acme/api', hasWebhook: false },
  ],
};

type Answer = { status: number; body: unknown };

// Holds the first read until `release` is called, then answers with `answer`.
async function holdRead(page: Page, answer: Answer) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/v1/dashboard*', async (route: Route) => {
    if (!isRead(route.request().url())) return route.fallback();
    await gate;
    return route.fulfill({
      status: answer.status,
      contentType: 'application/json',
      body: JSON.stringify(answer.body),
    });
  });
  return release;
}

const PAGES = [
  {
    name: 'Insights',
    url: '/insights.html',
    emptyTexts: [
      '0 repositories tracked',
      'No open pull requests.',
      'No open issues.',
    ],
    // The chart cards' own text on a failed read is #3361.
    failedHides: ['0 repositories tracked'],
    neutral: 'Checking tracked repositories...',
    zeroText: '0 repositories tracked',
    real: { selector: '#insights-tracked', text: '2 repositories tracked' },
    skeletons: 5,
  },
  {
    name: 'Webhooks',
    url: '/webhooks.html',
    emptyTexts: ['Nothing tracked yet'],
    failedHides: ['Nothing tracked yet'],
    neutral: 'Checking tracked repositories...',
    zeroText: 'Nothing tracked yet',
    real: { selector: '#webhooks-table', text: 'acme/web' },
    skeletons: 1,
  },
];

const wrap = (page: Page) => page.locator('[aria-busy="true"]');

for (const p of PAGES) {
  test.describe(`${p.name} while the first read is pending`, () => {
    test('shows skeletons, aria-busy, a status and a neutral label, then the real content', async ({
      page,
    }) => {
      const release = await holdRead(page, { status: 200, body: FULL });
      await page.goto(p.url);

      await expect(page.getByTestId('list-skeleton')).toHaveCount(p.skeletons);
      await expect(wrap(page)).toHaveCount(1);
      await expect(page.getByTestId('first-refresh-status')).toHaveText(
        'Loading your repositories…',
      );
      await expect(page.getByTestId('first-refresh-status')).toHaveAttribute(
        'aria-live',
        'polite',
      );
      if (p.name === 'Insights') {
        await expect(page.locator('#insights-tracked')).toHaveText(p.neutral);
      }
      for (const text of p.emptyTexts) {
        await expect(page.locator('body')).not.toContainText(text);
      }
      await expect(page.getByRole('alert')).toHaveCount(0);

      release();
      await expect(page.locator(p.real.selector)).toContainText(p.real.text);
      await expect(page.getByTestId('list-skeleton')).toHaveCount(0);
      await expect(wrap(page)).toHaveCount(0);
      await expect(page.getByTestId('first-refresh-status')).toHaveText('');
    });

    test('an answer that says the first refresh is not done is still pending', async ({
      page,
    }) => {
      const release = await holdRead(page, {
        status: 200,
        body: { ...EMPTY, firstRefreshDone: false },
      });
      await page.goto(p.url);
      release();

      await expect(page.getByTestId('list-skeleton')).toHaveCount(p.skeletons);
      await expect(wrap(page)).toHaveCount(1);
      for (const text of p.emptyTexts) {
        await expect(page.locator('body')).not.toContainText(text);
      }
    });

    test('a read that answers with zero records shows the real empty text', async ({
      page,
    }) => {
      const release = await holdRead(page, { status: 200, body: EMPTY });
      await page.goto(p.url);
      release();

      await expect(page.locator('body')).toContainText(p.zeroText);
      await expect(page.getByTestId('list-skeleton')).toHaveCount(0);
      await expect(wrap(page)).toHaveCount(0);
      if (p.name === 'Insights') {
        await expect(page.locator('body')).toContainText(
          'No open pull requests.',
        );
        await expect(page.locator('body')).not.toContainText(p.neutral);
      }
    });

    test('a failed read shows the alert, not the skeleton and not the empty text', async ({
      page,
    }) => {
      const release = await holdRead(page, {
        status: 500,
        body: { error: 'boom' },
      });
      await page.goto(p.url);
      await expect(page.getByTestId('list-skeleton')).toHaveCount(p.skeletons);
      release();

      await expect(page.getByRole('alert')).toContainText(
        'The backend answered with an error (500)',
      );
      await expect(page.getByTestId('list-skeleton')).toHaveCount(0);
      await expect(wrap(page)).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(p.neutral);
      for (const text of p.failedHides) {
        await expect(page.locator('body')).not.toContainText(text);
      }
    });

    test('the skeleton does not animate under reduced motion', async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await holdRead(page, { status: 200, body: FULL });
      await page.goto(p.url);
      const bar = page.locator('.skeleton-bar').first();
      await expect(bar).toBeVisible();
      expect(
        await bar.evaluate((el) => getComputedStyle(el).animationName),
      ).toBe('none');

      await page.emulateMedia({ reducedMotion: 'no-preference' });
      expect(
        await bar.evaluate((el) => getComputedStyle(el).animationName),
      ).toBe('skeleton-shimmer');
    });

    for (const scheme of ['light', 'dark'] as const) {
      test(`the pending state has no axe violations (${scheme})`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await holdRead(page, { status: 200, body: FULL });
        await page.goto(p.url);
        await expect(page.getByTestId('list-skeleton').first()).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  });
}
