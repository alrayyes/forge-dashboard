import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// #813: the page is built from CHANGELOG.md, turned into one same-origin
// JSON file at build time. It makes no request to GitHub or anyone else.
const CHANGELOG = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const CHANGELOG_VERSIONS = [
  ...CHANGELOG.matchAll(/^## \[?(\d+\.\d+\.\d+[^\]\s)]*)/gm),
].map((m) => m[1]);

async function waitForReleasesToSettle(page: Page) {
  await Promise.race([
    page.waitForSelector('.release', { timeout: 15000 }),
    page.waitForSelector('#status.error', { timeout: 15000 }),
  ]);
}

// #1135: the page shows the newest releases and reveals older ones on
// request, so a long history doesn't put thousands of elements on the page.
async function showAllReleases(page: Page) {
  const more = page.getByRole('button', { name: /older releases/i });
  while (await more.isVisible()) await more.click();
}

// One release with the given notes, served in place of changelog.json.
const oneRelease = (notes: string) => ({
  contentType: 'application/json',
  body: JSON.stringify({
    releases: [
      {
        version: '9.9.9',
        date: '2026-10-05',
        url: 'https://example.com',
        notes,
      },
    ],
  }),
});
async function serveNotes(page: Page, notes: string) {
  await page.route('**/changelog.json', (route) =>
    route.fulfill(oneRelease(notes)),
  );
}

// The Markdown renderer is a lazy chunk with a hashed name, so it is found by
// the markdown-it token name it carries. This is the one place that knows it.
const RENDERER_MARKER = 'blockquote_open';
// Aborts the renderer chunk, or holds it until the returned function is called.
async function interceptRendererChunk(page: Page, mode: 'abort' | 'hold') {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/_app/immutable/**/*.js', async (route) => {
    const response = await route.fetch();
    if ((await response.text()).includes(RENDERER_MARKER)) {
      if (mode === 'abort') return route.abort();
      await held;
    }
    return route.fulfill({ response });
  });
  return release;
}

test.describe('release history page', () => {
  test('reachable without a session, unlike the dashboard itself', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto('/changelog.html');
    await expect(page).toHaveURL(/\/changelog\.html$/);
    await expect(page.locator('.changelog-header h1')).toHaveText(
      'Release history',
    );
  });

  test('makes no request to GitHub and reads one same-origin JSON file', async ({
    page,
    baseURL,
  }) => {
    const hosts = new Set<string>();
    const urls: string[] = [];
    page.on('request', (r) => {
      const url = new URL(r.url());
      if (url.protocol.startsWith('http')) {
        hosts.add(url.host);
        urls.push(r.url());
      }
    });
    await page.goto('/changelog.html');
    await waitForReleasesToSettle(page);
    await expect(page.locator('.release').first()).toBeVisible();

    // The site-wide font stylesheet is the layout's own, not this page's.
    expect([...hosts].filter((h) => /github/i.test(h))).toEqual([]);
    const changelog = urls.find((u) => u.endsWith('/changelog.json'));
    expect(changelog).toBeDefined();
    expect(new URL(changelog ?? '').host).toBe(new URL(baseURL ?? '').host);
  });

  test('lists every release in CHANGELOG.md, newest first, with its notes', async ({
    page,
  }) => {
    expect(CHANGELOG_VERSIONS.length).toBeGreaterThan(0);
    await page.goto('/changelog.html');
    await waitForReleasesToSettle(page);
    await showAllReleases(page);

    await expect(page.locator('.release')).toHaveCount(
      CHANGELOG_VERSIONS.length,
    );
    const titles = await page.locator('.release h2').allInnerTexts();
    expect(titles.map((t) => t.trim())).toEqual(
      CHANGELOG_VERSIONS.map((v) => `v${v}`),
    );
    const first = page.locator('.release').first();
    await expect(first.locator('.release-date')).not.toHaveText('');
    await expect(first.locator('.release-notes li').first()).toBeVisible();
  });

  test('keeps the DOM small on load and reveals older releases on request', async ({
    page,
  }) => {
    // Needs more releases than one page holds, or there is nothing to page.
    expect(CHANGELOG_VERSIONS.length).toBeGreaterThan(20);
    await page.goto('/changelog.html');
    await waitForReleasesToSettle(page);

    const elements = await page.evaluate(
      () => document.querySelectorAll('*').length,
    );
    expect(elements).toBeLessThan(1500);
    const shown = await page.locator('.release').count();
    expect(shown).toBeLessThan(CHANGELOG_VERSIONS.length);

    const more = page.getByRole('button', { name: /older releases/i });
    await expect(more).toBeVisible();
    await more.click();
    expect(await page.locator('.release').count()).toBeGreaterThan(shown);
    await showAllReleases(page);
    await expect(more).toBeHidden();
    await expect(page.locator('.release')).toHaveCount(
      CHANGELOG_VERSIONS.length,
    );
  });

  // The notes come from commit messages, so a link in them is untrusted text
  // turned into an anchor. Only http(s) links may become one, and nothing in a
  // URL may break out of the href attribute (#891).
  test('a link in the release notes cannot run script or add an attribute', async ({
    page,
  }) => {
    const notes = [
      '### Features',
      '* a [scheme](javascript:alert(1)) link',
      '* a [quote](https://example.com/a"onmouseover="alert(2)) link',
      '* a [fine](https://example.com/ok) link',
    ].join('\n');
    await serveNotes(page, notes);
    await page.goto('/changelog.html');
    await waitForReleasesToSettle(page);

    const links = page.locator('.release-notes a');
    await expect(
      page.locator('.release-notes a[href="https://example.com/ok"]'),
    ).toHaveCount(1);
    for (const href of await links.evaluateAll((as) =>
      as.map((a) => a.getAttribute('href') ?? ''),
    )) {
      expect(href).toMatch(/^https?:\/\//);
    }
    expect(await page.locator('.release-notes [onmouseover]').count()).toBe(0);
  });

  // release-please writes Markdown: a bold scope, inline code, links, lists.
  // It shows as the matching element, not as the characters that asked for it.
  test('release notes render as Markdown, safely', async ({ page }) => {
    const notes = [
      '### Features',
      '* **web:** fix the `thing` ([#12](https://example.com/12)) ([6bf88c3](https://example.com/c))',
      '* a [scheme](javascript:alert(1)) link and <script>window.__ran = 1</script>',
    ].join('\n');
    await serveNotes(page, notes);
    await page.goto('/changelog.html');
    await waitForReleasesToSettle(page);

    const notesBox = page.locator('.release-notes');
    await expect(notesBox.locator('strong')).toHaveText('web:');
    await expect(notesBox.locator('code')).toHaveText('thing');
    await expect(notesBox).not.toContainText('**');
    await expect(notesBox.locator('li')).toHaveCount(2);
    await expect(notesBox.locator('a.mono')).toHaveText(['#12', '6bf88c3']);
    await expect(notesBox.locator('a[href^="javascript"]')).toHaveCount(0);
    await expect(notesBox.locator('script')).toHaveCount(0);
    await expect(notesBox).toContainText('<script>');
    expect(await page.evaluate(() => '__ran' in window)).toBe(false);
    for (const a of await notesBox.locator('a').all()) {
      await expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  // The Markdown renderer is a lazy chunk. If it never arrives, the notes
  // still read as text instead of an empty card.
  test('shows the notes as plain text when the renderer chunk is aborted', async ({
    page,
  }) => {
    await serveNotes(page, '### Features\n* **web:** a plain note');
    await interceptRendererChunk(page, 'abort');
    const aborted = page.waitForEvent('requestfailed', (r) =>
      r.url().includes('/_app/immutable/'),
    );
    await page.goto('/changelog.html');
    await waitForReleasesToSettle(page);
    await aborted;

    const notesBox = page.locator('.release-notes');
    await expect(notesBox).toContainText('* **web:** a plain note');
    await expect(notesBox.locator('strong')).toHaveCount(0);
  });

  // The card shows its text from the first paint, so the Markdown swap of a
  // short note does not push the cards below it. Two releases, the renderer chunk held back:
  // the second card's position is read before and after the swap.
  test('the notes swap to Markdown without moving the card below', async ({
    page,
  }) => {
    const notes = '### Features\n* **web:** a note';
    await page.route('**/changelog.json', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          releases: ['9.9.9', '9.9.8'].map((version) => ({
            version,
            date: '2026-10-05',
            url: 'https://example.com',
            notes,
          })),
        }),
      }),
    );
    const release = await interceptRendererChunk(page, 'hold');
    await page.goto('/changelog.html');
    await expect(page.locator('.release')).toHaveCount(2);
    await expect(page.locator('.release-notes').first()).not.toBeEmpty();

    const second = page.locator('.release').nth(1);
    const before = (await second.boundingBox())?.y ?? 0;
    expect(before).toBeGreaterThan(0);
    release();
    await expect(page.locator('.release-notes strong').first()).toHaveText(
      'web:',
    );
    const after = (await second.boundingBox())?.y ?? 0;
    expect(Math.abs(after - before)).toBeLessThan(12);
  });

  // A real release is several sections of bullets with scopes and reference
  // links. The raw text of those is longer than what they render to, so the
  // swap does shift the cards below by a few lines; this pins that the notes
  // are readable before it, complete after it, and that the card keeps its
  // place in the list.
  test('a multi-section release reads as text first and renders in full after the swap', async ({
    page,
  }) => {
    const bullet = (n: number) =>
      `* **web:** change number ${n} to the \`thing\` so a long enough line wraps ([#${n}](https://example.com/${n})) ([6bf88c${n}](https://example.com/c${n}))`;
    await serveNotes(
      page,
      [
        '### Features',
        ...[1, 2, 3, 4].map(bullet),
        '',
        '### Bug Fixes',
        ...[5, 6, 7].map(bullet),
        '',
        '### Performance Improvements',
        bullet(8),
      ].join('\n'),
    );
    const release = await interceptRendererChunk(page, 'hold');
    await page.goto('/changelog.html');
    await expect(page.locator('.plain-notes')).toContainText('change number 8');
    release();
    await expect(page.locator('.release-notes li')).toHaveCount(8);
    await expect(page.locator('.release-notes h3')).toHaveText([
      'Features',
      'Bug Fixes',
      'Performance Improvements',
    ]);
    await expect(page.locator('.plain-notes')).toHaveCount(0);
  });

  // A long URL in plain text has no break point. It wraps inside the card at
  // phone width instead of pushing the page sideways.
  test('a long unbroken URL in the plain notes wraps at phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const url = `https://example.com/${'a'.repeat(70)}`;
    await serveNotes(page, `* see ${url}`);
    await interceptRendererChunk(page, 'abort');
    await page.goto('/changelog.html');
    await waitForReleasesToSettle(page);
    await expect(page.locator('.plain-notes')).toContainText(url);

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  // Rendered Markdown has its own wrapping rule: a long link label is not
  // plain text and must not widen the card either.
  test('a long unbroken URL in rendered notes wraps at phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const url = `https://example.com/${'a'.repeat(70)}`;
    await serveNotes(page, `* see [${url}](${url}) and \`${'b'.repeat(70)}\``);
    await page.goto('/changelog.html');
    await waitForReleasesToSettle(page);
    await expect(page.locator('.release-notes a')).toHaveText(url);
    await expect(page.locator('.plain-notes')).toHaveCount(0);

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    const card = await page.locator('.release').boundingBox();
    expect(card?.width).toBeLessThanOrEqual(390);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`ordered lists, code blocks and quotes are styled and pass axe in ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await serveNotes(
        page,
        [
          '1. first',
          '2. second',
          '',
          '```',
          `const wide = '${'x'.repeat(200)}';`,
          '```',
          '',
          '> quoted note',
        ].join('\n'),
      );
      await page.goto('/changelog.html');
      await waitForReleasesToSettle(page);

      const notesBox = page.locator('.release-notes');
      await expect(notesBox.locator('ol li')).toHaveCount(2);
      const spacing = async (sel: string, prop: string) =>
        page
          .locator(sel)
          .first()
          .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
      expect(await spacing('.release-notes ol', 'padding-left')).toBe('20px');
      expect(await spacing('.release-notes pre', 'margin-bottom')).toBe('8px');
      expect(await spacing('.release-notes blockquote', 'margin-bottom')).toBe(
        '8px',
      );
      // Colours come from tokens, so they differ from the card's own and
      // follow the scheme.
      expect(await spacing('.release-notes pre', 'background-color')).not.toBe(
        await spacing('.release', 'background-color'),
      );
      expect(await spacing('.release-notes pre', 'border-top-width')).toBe(
        '1px',
      );
      expect(
        await spacing('.release-notes blockquote', 'border-left-width'),
      ).toBe('3px');
      expect(await spacing('.release-notes blockquote', 'color')).not.toBe(
        await spacing('.release-notes li', 'color'),
      );
      // A scrolling code block takes keyboard focus, so it can be read.
      await expect(notesBox.locator('pre')).toHaveAttribute('tabindex', '0');

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('a missing changelog file says so plainly and falls back to nothing', async ({
    page,
  }) => {
    const hosts = new Set<string>();
    page.on('request', (r) => hosts.add(new URL(r.url()).host));
    await page.route('**/changelog.json', (route) =>
      route.fulfill({ status: 404 }),
    );
    await page.goto('/changelog.html');
    await waitForReleasesToSettle(page);

    await expect(page.locator('#status.error')).toContainText(
      'Could not load the changelog',
    );
    await expect(page.locator('.release')).toHaveCount(0);
    expect(hosts.has('api.github.com')).toBe(false);
  });

  test.describe('signed in', () => {
    // #786: the footer's version is the way in to this page. CI builds a dev
    // binary (plain text, no link), so a released version is mocked.
    test('the footer version links here from other pages, and stays a link marked current on this one', async ({
      page,
    }) => {
      await page.route('**/api/version', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ version: '1.2.3' }),
        }),
      );
      await page.goto('/pull-requests.html');

      const versionLink = page.locator('#footer-version a', {
        hasText: 'v1.2.3',
      });
      await expect(versionLink).toHaveAttribute('href', '/changelog.html');
      await versionLink.click();
      await expect(page).toHaveURL(/\/changelog\.html$/);

      // The owner decided (#1679) the link stays on its own page, marked
      // current, instead of turning into plain text.
      await expect(versionLink).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('#footer-version')).not.toContainText(
        'Release history',
      );
    });
  });

  test('has no axe-core violations at desktop width', async ({ page }) => {
    await page.goto('/changelog.html');
    await waitForReleasesToSettle(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/changelog.html');
    await waitForReleasesToSettle(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    const clientWidth = await page.evaluate(
      () => document.documentElement.clientWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
