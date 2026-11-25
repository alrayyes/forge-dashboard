import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// A conflict, a conflict check and a conflict the forge has not confirmed each
// print their reason once, as real text: no repeat in the pill, the status
// block, the footer and the Out of date chip, and no hover-only "i".
// https://github.com/alrayyes/forge-dashboard/issues/4531

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function pr(number: number, title: string, over: Record<string, unknown> = {}) {
  return {
    forge: 'forgejo',
    repo: 'example/app',
    number,
    title,
    url: `https://example.com/pull/${number}`,
    author: 'someone',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'conflicting',
    behind: true,
    kind: 'regular',
    ...over,
  };
}

const CONFLICT_NEXT = 'Resolve it on the forge to unlock Merge';
const confirmed = pr(1, 'Confirmed conflict', {
  conflictConfirmed: true,
  conflictFiles: ['a.txt'],
  status: { code: 'conflict', message: 'Merge conflict', next: CONFLICT_NEXT },
  allowedActions: [
    {
      action: 'merge',
      blocked: {
        code: 'conflict',
        message: 'Merge conflict',
        next: CONFLICT_NEXT,
      },
    },
    {
      action: 'update_branch',
      blocked: {
        code: 'conflict',
        message: 'Conflicts need fixing by hand — resolve them on the forge.',
      },
    },
    { action: 'close' },
  ],
});

const UNCONFIRMED_NEXT =
  'The forge hasn’t confirmed it. Update the branch to find out';
const unconfirmed = pr(2, 'Unconfirmed conflict', {
  conflictConfirmed: false,
  status: {
    code: 'conflict',
    message: 'Conflict not confirmed',
    next: UNCONFIRMED_NEXT,
  },
  allowedActions: [
    {
      action: 'merge',
      blocked: {
        code: 'conflict',
        message: 'Conflict not confirmed',
        next: UNCONFIRMED_NEXT,
      },
    },
    {
      action: 'update_branch',
      blocked: { code: 'conflict', message: 'Conflicts need fixing by hand' },
    },
    { action: 'close' },
  ],
});

const checking = pr(3, 'Checking conflicts', {
  mergeStatus: 'checking',
  behind: false,
  status: {
    code: 'checks_pending',
    message: 'Checking for conflicts',
    next: 'Merge unlocks once the forge finishes',
  },
  allowedActions: [
    {
      action: 'merge',
      blocked: {
        code: 'checks_pending',
        message: 'Checking for conflicts',
        next: 'Merge unlocks once the forge finishes',
      },
    },
    { action: 'close' },
  ],
});

async function open(page: Page, prs: unknown[]) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('forgejo')],
        pullRequests: prs,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(prs.length);
}

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title });

const axe = (page: Page) =>
  new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();

// Nothing a hover has to reveal: no "i" hint, no tooltip bubble.
async function expectNoHoverOnly(scope: Locator) {
  await expect(scope.locator('.row-action-locked-hint')).toHaveCount(0);
  await expect(scope.locator('.row-action-reason')).toHaveCount(0);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test.describe(`${scheme}, ${width}px`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
      });

      test('a confirmed conflict is printed once in the pop-up, with no Out of date chip', async ({
        page,
      }) => {
        await open(page, [confirmed]);
        const dialog = await openActionsDialog(row(page, 'Confirmed'));

        await expect(dialog.locator('.merge-pill')).toHaveCount(0);
        await expect(dialog.getByText('Out of date')).toHaveCount(0);
        await expect(dialog.getByText(CONFLICT_NEXT)).toHaveCount(1);
        await expect(
          dialog.getByText('Conflicts need fixing by hand'),
        ).toHaveCount(0);
        await expectNoHoverOnly(dialog);

        // The locked buttons stay, and the printed block is their reason.
        for (const name of ['Merge', 'Update branch']) {
          const button = actionsFooter(dialog).getByRole('button', {
            name,
            exact: true,
          });
          await expect(button).toHaveAttribute('aria-disabled', 'true');
          await expect(button).toHaveAccessibleDescription(
            new RegExp(`Merge conflict.*${CONFLICT_NEXT}`),
          );
        }
        expect((await axe(page)).violations).toEqual([]);
      });

      test('Forgejo checking for conflicts is one line, with no pill saying it again', async ({
        page,
      }) => {
        await open(page, [checking]);
        const r = row(page, 'Checking conflicts');
        await expect(r.getByText('Checking for conflicts')).toBeVisible();
        await expect(r.locator('.merge-pill')).toHaveCount(0);
        await expect(r.getByText('Checking for conflicts')).toHaveCount(1);
        await expect(
          r.getByRole('button', { name: 'Merge', exact: true }),
        ).toHaveCount(0);

        const dialog = await openActionsDialog(r);
        await expect(dialog.locator('.merge-pill')).toHaveCount(0);
        await expect(dialog.getByText('Checking for conflicts')).toHaveCount(1);
        expect((await axe(page)).violations).toEqual([]);
      });

      test('an unconfirmed conflict prints its reason beside the locked buttons, with no "i"', async ({
        page,
      }) => {
        await open(page, [unconfirmed]);
        const r = row(page, 'Unconfirmed conflict');
        await expect(r.locator('.merge-pill.unconfirmed')).toHaveText(
          'Conflict not confirmed',
        );
        // Real text from the first paint: no tap to open it.
        await expect(r.locator('.merge-where')).toBeVisible();
        await expect(r.locator('.merge-where')).toContainText(
          'No merge or update has been refused with a conflict yet',
        );
        await expect(
          r.getByRole('button', { name: 'Conflict not confirmed' }),
        ).toHaveCount(0);
        await expectNoHoverOnly(r);
        for (const name of ['Merge', 'Update branch']) {
          const button = r.getByRole('button', { name, exact: true });
          if ((await button.count()) === 0) continue;
          await expect(button).toHaveAccessibleDescription(
            /No merge or update has been refused/,
          );
        }
        expect((await axe(page)).violations).toEqual([]);

        const dialog = await openActionsDialog(r);
        await expect(dialog.locator('.merge-where')).toBeVisible();
        await expectNoHoverOnly(dialog);
        for (const name of ['Merge', 'Update branch']) {
          await expect(
            actionsFooter(dialog).getByRole('button', { name, exact: true }),
          ).toHaveAccessibleDescription(/No merge or update has been refused/);
        }
        expect((await axe(page)).violations).toEqual([]);
      });
    });
  }
}
