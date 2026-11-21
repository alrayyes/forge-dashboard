import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3764: an issue or pull request number in a release note opens its dialog
// where the reader is, read-only, when the forge can show it. A modified or
// middle click, a read that fails and an early click all keep the forge link.
// The page needs a session (#4426), so the dashboard's own read endpoint is
// the one asked, exactly as for a mention in a description (#4269).
// https://github.com/alrayyes/forge-dashboard/issues/3764

const REPO = 'alrayyes/forge-dashboard';
const FORGE = `https://github.com/${REPO}`;
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
const details = (text: string) => ({
  description: body(text),
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
});

const NOTES = [
  '### Bug Fixes',
  `* **web:** fix it ([#12](${FORGE}/issues/12)) ([6bf88c3](${FORGE}/commit/6bf88c3)), closes [#13](${FORGE}/issues/13)`,
  '* see stranger/elsewhere#9 and #14',
].join('\n');

async function serveChangelog(page: Page, notes = NOTES) {
  await page.route('**/changelog.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        releases: [
          {
            version: '9.9.9',
            date: '2026-10-05',
            url: `${FORGE}/releases/tag/v9.9.9`,
            notes,
          },
        ],
      }),
    }),
  );
}

// The issues route answers for the numbers in `readable`, and says 404 for
// the rest. `asked` lists what it was asked, as owner/name#number.
async function answerDetails(page: Page, readable: number[]) {
  const asked: string[] = [];
  await page.route('**/api/v1/issues/details*', (route: Route) => {
    const q = new URL(route.request().url()).searchParams;
    const number = Number(q.get('number'));
    asked.push(`${q.get('fullName')}#${number}`);
    return route.fulfill({
      status: readable.includes(number) ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(
        readable.includes(number)
          ? {
              ...details(`Text of ${q.get('fullName')}#${number}`),
              state: 'closed',
            }
          : { error: 'not found' },
      ),
    });
  });
  return asked;
}

async function open(page: Page) {
  await serveChangelog(page);
  await page.goto('/changelog.html');
  await page.waitForSelector('.release-notes a.mono');
}

const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const link = (page: Page, name: RegExp) => page.getByRole('link', { name });

async function warm(page: Page, target: ReturnType<typeof link>) {
  const answered = page.waitForResponse('**/api/v1/issues/details*');
  await target.hover();
  await answered;
}

test.describe('a reference in a release note opens its dialog (#3764)', () => {
  test('a plain click opens the dialog, read-only, with no navigation, and Escape returns focus to the link', async ({
    page,
  }) => {
    await answerDetails(page, [12]);
    await open(page);
    const ref = link(page, /^#12/);
    // Still a forge link, for a modified click and one that is early.
    await expect(ref).toHaveAttribute('href', `${FORGE}/issues/12`);
    await expect(ref).toHaveAttribute('target', '_blank');
    await warm(page, ref);
    const before = page.url();
    const scroll = await page.evaluate(() => window.scrollY);

    await ref.click();

    await expect(issueDialog(page)).toBeVisible();
    await expect(issueDialog(page)).toContainText(`Text of ${REPO}#12`);
    // Nothing here writes to the forge.
    await expect(issueDialog(page).getByRole('button')).toHaveCount(1);
    expect(page.context().pages()).toHaveLength(1);
    expect(page.url()).toBe(before);
    expect(await page.evaluate(() => window.scrollY)).toBe(scroll);

    await page.keyboard.press('Escape');
    await expect(issueDialog(page)).toBeHidden();
    await expect(ref).toBeFocused();
  });

  test('the close button and the backdrop return focus to the link too', async ({
    page,
  }) => {
    await answerDetails(page, [12]);
    await open(page);
    const ref = link(page, /^#12/);
    await warm(page, ref);
    await ref.click();
    await issueDialog(page).getByRole('button', { name: /close/i }).click();
    await expect(issueDialog(page)).toBeHidden();
    await expect(ref).toBeFocused();

    await ref.click();
    await expect(issueDialog(page)).toBeVisible();
    await page.mouse.click(2, 2);
    await expect(issueDialog(page)).toBeHidden();
    await expect(ref).toBeFocused();
  });

  test('focus on the link asks the forge, so Enter opens the dialog', async ({
    page,
  }) => {
    await answerDetails(page, [12]);
    await open(page);
    const answered = page.waitForResponse('**/api/v1/issues/details*');
    await link(page, /^#12/).focus();
    await answered;

    await page.keyboard.press('Enter');

    await expect(issueDialog(page)).toBeVisible();
    expect(page.context().pages()).toHaveLength(1);
  });

  test('a read that fails follows the link to the forge in a new tab', async ({
    page,
  }) => {
    await answerDetails(page, []);
    await open(page);
    const ref = link(page, /^#13/);
    await warm(page, ref);
    await expect(ref).toHaveAccessibleName(
      '#13 (opens on the forge in a new tab)',
    );
    const popup = page.context().waitForEvent('page');

    await ref.click();

    const tab = await popup;
    await tab.waitForURL(new RegExp(`${FORGE}/(issues|pull)/13$`), {
      waitUntil: 'commit',
    });
    await tab.close();
    await expect(issueDialog(page)).toBeHidden();
  });

  test('a click before the forge has answered follows the link', async ({
    page,
  }) => {
    let answer: () => void = () => {};
    let asked = 0;
    await page.route('**/api/v1/issues/details*', async (route: Route) => {
      asked++;
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...details('Slow'), state: 'closed' }),
      });
    });
    await open(page);
    const ref = link(page, /^#12/);
    await ref.hover();
    await expect.poll(() => asked).toBe(1);
    const popup = page.context().waitForEvent('page');

    await ref.click();

    const tab = await popup;
    await tab.waitForURL(new RegExp(`${FORGE}/(issues|pull)/12$`), {
      waitUntil: 'commit',
    });
    await tab.close();
    answer();
    await expect(issueDialog(page)).toBeHidden();
  });

  test("a ctrl, cmd or middle click is the browser's, even once the forge has answered", async ({
    page,
  }) => {
    await answerDetails(page, [12]);
    await open(page);
    const ref = link(page, /^#12/);
    await warm(page, ref);

    for (const click of [
      () => ref.click({ modifiers: ['ControlOrMeta'] }),
      () => ref.click({ modifiers: ['Shift'] }),
      () => ref.click({ button: 'middle' }),
    ]) {
      const popup = page.context().waitForEvent('page');
      await click();
      const tab = await popup;
      await tab.waitForURL(new RegExp(`${FORGE}/(issues|pull)/12$`), {
        waitUntil: 'commit',
      });
      await tab.close();
      await expect(issueDialog(page)).toBeHidden();
    }
  });

  test("a reference resolves against the repository it names, never the changelog's by default", async ({
    page,
  }) => {
    const asked = await answerDetails(page, [9, 12, 14]);
    await open(page);

    await warm(page, link(page, /^stranger\/elsewhere#9/));
    await warm(page, link(page, /^#14/));
    await warm(page, link(page, /^#12/));

    expect(asked.sort()).toEqual([
      `${REPO}#12`,
      `${REPO}#14`,
      'stranger/elsewhere#9',
    ]);
    await link(page, /^stranger\/elsewhere#9/).click();
    await expect(issueDialog(page)).toContainText(
      'Text of stranger/elsewhere#9',
    );
  });

  test('a note with no GitHub release address keeps its forge links', async ({
    page,
  }) => {
    const asked = await answerDetails(page, [12]);
    await page.route('**/changelog.json', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          releases: [
            {
              version: '9.9.9',
              date: '2026-10-05',
              url: 'https://example.com',
              notes: `* fix ([#12](${FORGE}/issues/12))`,
            },
          ],
        }),
      }),
    );
    await page.goto('/changelog.html');
    const ref = page.locator('.release-notes a.mono').first();
    await ref.hover();
    await page.waitForTimeout(600);
    expect(asked).toEqual([]);
    await expect(ref).toHaveAttribute('target', '_blank');
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [360, 390, 1280]) {
      test(`axe finds nothing with the dialog closed and open at ${width}px, ${scheme}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 800 });
        await answerDetails(page, [12]);
        await open(page);
        const axe = () =>
          new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
        expect((await axe()).violations).toEqual([]);

        const ref = link(page, /^#12/);
        await warm(page, ref);
        await ref.click();
        await expect(issueDialog(page)).toBeVisible();
        expect((await axe()).violations).toEqual([]);

        // Usable on a phone: it fits the screen and the close is in reach.
        const box = await issueDialog(page).boundingBox();
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
        await expect(
          issueDialog(page).getByRole('button', { name: /close/i }),
        ).toBeInViewport();
      });
    }
  }
});
