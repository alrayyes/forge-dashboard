import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import {
  clearLabels,
  labelButton,
  labelPanel,
  pickedLabels,
  pickOnly,
  pickTexts,
  toggleLabels,
} from './label-filter-helper';
import { test } from './server-fixture';

// The Label filter takes several labels at once and shows what carries any of
// them. It is a button that opens a group of checkboxes, so it works by
// keyboard and screen reader, and in the Filters sheet on a phone. A label
// saved before there was a list is a list of one.
//
// Research the control and the "any, not all" wording are built on:
//   https://adrianroselli.com/2022/05/under-engineered-multi-selects.html
//   https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/
//   https://design-system.service.gov.uk/components/checkboxes/
//   https://primer.style/components/action-list (multi-select)
// https://github.com/alrayyes/forge-dashboard/issues/2085

const NOW = new Date().toISOString();

function pr(
  number: number,
  author: string,
  ...labels: string[]
): Record<string, unknown> {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author,
    draft: false,
    ci: 'success',
    labels: labels.map((name) => ({ name, color: 'ededed' })),
    createdAt: NOW,
    updatedAt: NOW,
    mergeStatus: 'mergeable',
  };
}

// 1 alice bug, 2 bob security, 3 alice docs, 4 bob bug and docs.
const PRS = [
  pr(1, 'alice', 'bug'),
  pr(2, 'bob', 'security'),
  pr(3, 'alice', 'docs'),
  pr(4, 'bob', 'bug', 'docs'),
];

function issue(number: number, ...labels: string[]) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: 'ryan',
    labels: labels.map((name) => ({ name, color: 'ededed' })),
    createdAt: NOW,
    updatedAt: NOW,
  };
}
const ISSUES = [issue(1, 'bug'), issue(2, 'question'), issue(3, 'enhancement')];

async function mock(page: Page, prs: Record<string, unknown>[] = PRS) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: NOW,
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: prs,
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

async function open(
  page: Page,
  url = '/pull-requests.html',
  prs: Record<string, unknown>[] = PRS,
) {
  await mock(page, prs);
  await page.goto(url);
  await expect(
    page.locator('#pr-rows, #issue-rows, .filter-bar').first(),
  ).toBeVisible();
}

const prRows = (page: Page) => page.locator('#pr-rows > .row');
const issueRows = (page: Page) => page.locator('#issue-rows > .row');

async function seedCookie(
  page: Page,
  baseURL: string | undefined,
  label: string,
) {
  await page.context().addCookies([
    {
      name: 'forge-board-filters',
      value: encodeURIComponent(JSON.stringify({ shared: { label } })),
      url: baseURL ?? 'http://localhost:8080',
    },
  ]);
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe('Label filter: several labels, matching any', () => {
  test('ticking two labels lists the pull requests with either, and the button counts them', async ({
    page,
  }) => {
    await open(page);
    await expect(prRows(page)).toHaveCount(4);
    await expect(labelButton(page)).toHaveText('All labels');

    await toggleLabels(page, 'bug', 'security');

    await expect(prRows(page)).toHaveCount(3);
    await expect(prRows(page)).toContainText([
      'Pull request 1',
      'Pull request 2',
      'Pull request 4',
    ]);
    await expect(labelButton(page)).toHaveText('2 labels');
    expect(await pickedLabels(page)).toEqual(['bug', 'security']);
  });

  test('says that it shows items with any of the ticked labels', async ({
    page,
  }) => {
    await open(page);
    await labelButton(page).click();
    await expect(labelPanel(page)).toContainText(
      'Shows items with any of the ticked labels.',
    );
  });

  test('one label shows its name and filters as before', async ({ page }) => {
    await open(page);
    await toggleLabels(page, 'docs');

    await expect(prRows(page)).toHaveCount(2);
    await expect(labelButton(page)).toHaveText('docs');
  });

  test('unticking down to none shows everything again', async ({ page }) => {
    await open(page);
    await toggleLabels(page, 'bug', 'security');
    await toggleLabels(page, 'bug', 'security');

    await expect(prRows(page)).toHaveCount(4);
    await expect(labelButton(page)).toHaveText('All labels');
  });

  test('Clear labels empties the pick', async ({ page }) => {
    await open(page);
    await toggleLabels(page, 'bug', 'docs');
    await expect(prRows(page)).toHaveCount(3);

    await clearLabels(page);
    await expect(prRows(page)).toHaveCount(4);
    await expect(labelButton(page)).toHaveText('All labels');
  });

  test('clicking a label on a row adds it to the pick, and clicking it again removes it', async ({
    page,
  }) => {
    await open(page);
    await toggleLabels(page, 'bug');
    await expect(prRows(page)).toHaveCount(2);

    await prRows(page)
      .nth(1)
      .locator('.label-chip', { hasText: 'docs' })
      .click();
    await expect(labelButton(page)).toHaveText('2 labels');
    await expect(prRows(page)).toHaveCount(3);

    await prRows(page)
      .first()
      .locator('.label-chip', { hasText: 'bug' })
      .click();
    await expect(labelButton(page)).toHaveText('docs');
    await expect(prRows(page)).toHaveCount(2);
  });

  test('the pick is saved as it always was: lowercase, in the one label field', async ({
    page,
  }) => {
    await open(page);
    await toggleLabels(page, 'bug');
    await expect
      .poll(async () => {
        const res = await page.request.get('/api/settings/filter-state');
        return (await res.json()).shared?.label;
      })
      .toBe('bug');

    await toggleLabels(page, 'security');
    await expect
      .poll(async () => {
        const res = await page.request.get('/api/settings/filter-state');
        return (await res.json()).shared?.label;
      })
      .toBe('bug\nsecurity');
  });

  test('works on the Issues page too', async ({ page }) => {
    await open(page, '/issues.html');
    await expect(issueRows(page)).toHaveCount(3);

    await toggleLabels(page, 'bug', 'question');
    await expect(issueRows(page)).toHaveCount(2);
    await expect(labelButton(page)).toHaveText('2 labels');
  });
});

test.describe('Label filter: names and sizes', () => {
  test('a mixed-case label is ticked as written and matches in lowercase', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html', [
      pr(1, 'alice', 'Kind/Bug'),
      pr(2, 'bob', 'docs'),
    ]);
    await toggleLabels(page, 'Kind/Bug');

    await expect(prRows(page)).toHaveCount(1);
    await expect(labelButton(page)).toHaveText('Kind/Bug');
    expect(await pickedLabels(page)).toEqual(['kind/bug']);
  });

  test('a label with a line break in its name stays one choice and matches', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html', [
      pr(1, 'alice', 'odd\nname'),
      pr(2, 'bob', 'docs'),
    ]);
    await toggleLabels(page, 'odd name');

    await expect(prRows(page)).toHaveCount(1);
    expect(await pickedLabels(page)).toEqual(['odd name']);
  });

  test('stops at twenty labels: the other boxes are disabled', async ({
    page,
  }) => {
    const prs = Array.from({ length: 22 }, (_, i) => pr(i + 1, 'a', `l${i}`));
    await open(page, '/pull-requests.html', prs);
    await labelButton(page).click();
    for (let i = 0; i < 20; i++)
      await labelPanel(page)
        .getByRole('checkbox', { name: `l${i}`, exact: true })
        .check();

    await expect(labelButton(page)).toHaveText('20 labels');
    await expect(
      labelPanel(page).getByRole('checkbox', { name: 'l20', exact: true }),
    ).toBeDisabled();
    await expect(labelPanel(page)).toContainText('Up to 20');
  });
});

test.describe('Label filter: saved picks', () => {
  test('a single label saved before the list existed is a one-item selection', async ({
    page,
    baseURL,
  }) => {
    await seedCookie(page, baseURL, 'bug');
    await open(page);

    await expect(prRows(page)).toHaveCount(2);
    await expect(labelButton(page)).toHaveText('bug');
    expect(await pickedLabels(page)).toEqual(['bug']);
  });

  test('several saved labels come back ticked', async ({ page, baseURL }) => {
    await seedCookie(page, baseURL, 'bug\ndocs');
    await open(page);

    await expect(prRows(page)).toHaveCount(3);
    await expect(labelButton(page)).toHaveText('2 labels');
    expect(await pickedLabels(page)).toEqual(['bug', 'docs']);
  });

  test('a pick survives a reload', async ({ page }) => {
    await open(page);
    await toggleLabels(page, 'bug', 'docs');
    await page.reload();

    await expect(prRows(page)).toHaveCount(3);
    expect(await pickedLabels(page)).toEqual(['bug', 'docs']);
  });
});

test.describe('Label filter: narrowing', () => {
  test('offers only the labels on the pull requests the other filters leave', async ({
    page,
  }) => {
    await open(page);
    await pickOnly(page, 'author', 'alice');

    await labelButton(page).click();
    await expect(labelPanel(page).locator('.label-filter-option')).toHaveText([
      'bug',
      'docs',
    ]);
  });

  test('the other filters offer only what the ticked labels leave', async ({
    page,
  }) => {
    await open(page);
    await toggleLabels(page, 'security', 'docs');

    // bob wrote the security one and the bug+docs one, alice the docs one.
    await expect
      .poll(() => pickTexts(page, 'author'))
      .toEqual(['alice', 'bob']);
    await clearLabels(page);
    await toggleLabels(page, 'security');
    await expect.poll(() => pickTexts(page, 'author')).toEqual(['bob']);
  });

  test('a ticked label that a later filter leaves nothing for is cleared, the others stay', async ({
    page,
  }) => {
    await open(page);
    await toggleLabels(page, 'bug', 'security');
    await expect(prRows(page)).toHaveCount(3);

    await pickOnly(page, 'author', 'alice');

    // security is bob's: alice has none, so it can no longer be ticked.
    await expect(labelButton(page)).toHaveText('bug');
    await expect(prRows(page)).toHaveCount(1);
    expect(await pickedLabels(page)).toEqual(['bug']);
  });

  test('a saved label this page does not offer is said out loud, not silently kept', async ({
    page,
    baseURL,
  }) => {
    await seedCookie(page, baseURL, 'bug\nretired');
    await open(page);

    await expect(labelButton(page)).toHaveText('bug');
    await expect(page.locator('#held-picks')).toContainText(
      'Saved label "retired" is not on this page.',
    );
  });
});

test.describe('Label filter: keyboard and screen reader', () => {
  test('opens with Enter, ticks with Space, closes with Escape and returns focus', async ({
    page,
  }) => {
    await open(page);
    const button = labelButton(page);
    await button.focus();
    await expect(button).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(
      labelPanel(page).getByRole('group', { name: 'Label' }),
    ).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(
      labelPanel(page).getByRole('checkbox', { name: 'bug' }),
    ).toBeFocused();
    await page.keyboard.press('Space');
    await expect(prRows(page)).toHaveCount(2);
    // Focus stays on the box through the rebuild of the choices.
    await expect(
      labelPanel(page).getByRole('checkbox', { name: 'bug' }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(prRows(page)).toHaveCount(3);

    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toBeFocused();
    await expect(button).toHaveText('2 labels');
  });

  test('a change is announced politely once, with the count', async ({
    page,
  }) => {
    await open(page);
    const live = page.locator('#shared-label-filter [role="status"]').first();
    await expect(live).toHaveAttribute('aria-live', 'polite');

    await toggleLabels(page, 'bug');
    await expect(live).toHaveText('2 pull requests');

    await toggleLabels(page, 'security');
    await expect(live).toHaveText('3 pull requests');
  });

  test('the button names itself and what is picked', async ({ page }) => {
    await open(page);
    await expect(labelButton(page)).toHaveAccessibleName(
      'Filter by label: All labels',
    );
    await toggleLabels(page, 'bug', 'docs');
    await expect(labelButton(page)).toHaveAccessibleName(
      'Filter by label: 2 labels',
    );
  });

  test('has no axe violations open with two ticked, in light and dark', async ({
    page,
  }) => {
    await open(page);
    await labelButton(page).click();
    await labelPanel(page).getByRole('checkbox', { name: 'bug' }).check();
    await labelPanel(page).getByRole('checkbox', { name: 'docs' }).check();
    await axe(page);

    await page.emulateMedia({ colorScheme: 'dark' });
    await axe(page);
  });
});

test.describe('Label filter: the open group stays inside the window', () => {
  // The button can be the last control on its row, so a group opening to the
  // right of it would run off the window and cut its text.
  for (const width of [1024, 1280, 1440, 1920]) {
    for (const url of [
      '/pull-requests.html',
      '/issues.html',
      '/insights.html',
    ]) {
      test(`${url} at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await open(page, url);
        await expect(labelButton(page)).toBeVisible();
        await labelButton(page).click();
        await expect(labelPanel(page)).toBeVisible();

        const box = await labelPanel(page).boundingBox();
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
        // Its own text isn't cut off either.
        const clipped = await labelPanel(page).evaluate(
          (el) => el.scrollWidth > el.clientWidth,
        );
        expect(clipped).toBe(false);
      });
    }
  }
});

test.describe('Label filter: on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const sheet = (page: Page) => page.locator('#filter-sheet');

  test('lives in the Filters sheet, with 44px targets, and Escape closes the choices before the sheet', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: /^Filters/ }).click();
    await expect(sheet(page)).toBeVisible();

    await labelButton(page).click();
    const box = await labelPanel(page)
      .locator('.label-filter-option')
      .first()
      .boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    // One choice per line, not side by side.
    const second = await labelPanel(page)
      .locator('.label-filter-option')
      .nth(1)
      .boundingBox();
    expect(second?.y ?? 0).toBeGreaterThanOrEqual(
      (box?.y ?? 0) + (box?.height ?? 0) - 1,
    );
    await labelPanel(page).getByRole('checkbox', { name: 'bug' }).check();
    await labelPanel(page).getByRole('checkbox', { name: 'docs' }).check();
    await expect(
      sheet(page).getByRole('button', { name: 'Show 3 results' }),
    ).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(labelPanel(page)).toBeHidden();
    await expect(sheet(page)).toBeVisible();
    await expect(labelButton(page)).toBeFocused();

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('each ticked label is a chip with its own remove button', async ({
    page,
    baseURL,
  }) => {
    await seedCookie(page, baseURL, 'bug\ndocs');
    await open(page);

    const chips = page.locator('#active-filters .filter-chip');
    await expect(chips).toHaveCount(2);
    await expect(
      page.getByRole('button', { name: 'Remove filter: Label bug' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Remove filter: Label bug' })
      .click();

    await expect(chips).toHaveCount(1);
    await expect(prRows(page)).toHaveCount(2);
    await page.getByRole('button', { name: /^Filters/ }).click();
    await expect(labelButton(page)).toHaveText('docs');
  });

  test('has no axe violations with the choices open in the sheet, light and dark', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: /^Filters/ }).click();
    await labelButton(page).click();
    await labelPanel(page).getByRole('checkbox', { name: 'bug' }).check();
    await axe(page);

    await page.emulateMedia({ colorScheme: 'dark' });
    await axe(page);
  });
});
