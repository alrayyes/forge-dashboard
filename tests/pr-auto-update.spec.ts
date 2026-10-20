import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { openActionsDialog } from './actions-dialog-helper';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// A pull request's own choice about the dashboard updating its branch for it:
// the checkbox in the details dialog, the reason when it can't apply, and the
// row's marker. The server decides and stores the state (the Go tests prove
// the rules); this proves the page shows what it is given and sends the
// change.

type AutoUpdate = {
  enabled: boolean;
  source: 'repo' | 'pullRequest';
  unavailable: { code: string; reason: string } | null;
};

const FOLLOWS_REPO_ON: AutoUpdate = {
  enabled: true,
  source: 'repo',
  unavailable: null,
};

function makePR(
  autoUpdate: AutoUpdate,
  overrides: Record<string, unknown> = {},
) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    autoUpdate,
    ...overrides,
  };
}

// Serves one pull request whose state the spec changes, the way the server
// would after a write, and records what the page posted.
async function serve(
  page: Page,
  state: {
    pr: Record<string, unknown>;
    posts: Record<string, unknown>[];
    respond?: (body: Record<string, unknown>) => AutoUpdate | null;
  },
) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  // The read and the refresh the page asks for after a change both get the
  // current state.
  const snapshot = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [state.pr],
        issues: [],
      }),
    });
  await page.route('**/api/dashboard*', snapshot);
  await page.route('**/api/dashboard/refresh*', snapshot);
  await page.route('**/api/pull-requests/auto-update', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.posts.push(body);
    const next = state.respond?.(body);
    if (next === null)
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"could not save"}',
      });
    if (next) state.pr = { ...state.pr, autoUpdate: next };
    return route.fulfill({ status: 204 });
  });
}

const row = (page: Page) => page.locator('#pr-rows .row').first();
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('A pull request can have its own automatic branch update', () => {
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('the checkbox shows the effective value and where it comes from', async ({
    page,
  }) => {
    await serve(page, { pr: makePR(FOLLOWS_REPO_ON), posts: [] });
    await page.goto('/pull-requests.html');

    const dialog = await openActionsDialog(row(page));
    const box = dialog.getByRole('checkbox', {
      name: 'Update this branch automatically',
    });

    await expect(box).toBeChecked();
    await expect(dialog.getByText("From the repo's setting.")).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: "Use the repo's setting" }),
    ).toHaveCount(0);
  });

  test('unticking saves at once, keeps focus, and offers the way back to the repo', async ({
    page,
  }) => {
    const state = {
      pr: makePR(FOLLOWS_REPO_ON),
      posts: [] as Record<string, unknown>[],
      respond: (body: Record<string, unknown>): AutoUpdate => ({
        enabled: body.enabled === null ? true : (body.enabled as boolean),
        source: body.enabled === null ? 'repo' : 'pullRequest',
        unavailable: null,
      }),
    };
    await serve(page, state);
    await page.goto('/pull-requests.html');
    const dialog = await openActionsDialog(row(page));
    const box = dialog.getByRole('checkbox', {
      name: 'Update this branch automatically',
    });

    await box.uncheck();

    await expect(box).not.toBeChecked();
    await expect(box).toBeFocused();
    await expect(dialog.getByText('Set for this pull request.')).toBeVisible();
    expect(state.posts).toEqual([
      {
        forge: 'github',
        fullName: 'alrayyes/forge-dashboard',
        number: 42,
        enabled: false,
      },
    ]);

    await dialog
      .getByRole('button', { name: "Use the repo's setting" })
      .click();

    await expect(box).toBeChecked();
    await expect(dialog.getByText("From the repo's setting.")).toBeVisible();
    expect(state.posts[1]).toMatchObject({ enabled: null });
  });

  test('a choice of its own is marked on the row in words, and a followed one is not', async ({
    page,
  }) => {
    await serve(page, {
      pr: makePR({ enabled: false, source: 'pullRequest', unavailable: null }),
      posts: [],
    });
    await page.goto('/pull-requests.html');
    await expect(row(page).getByText('Auto-update off')).toBeVisible();

    await page.unroute('**/api/dashboard*');
    await page.unroute('**/api/dashboard/refresh*');
    await serve(page, { pr: makePR(FOLLOWS_REPO_ON), posts: [] });
    await page.goto('/pull-requests.html');
    await expect(row(page)).toBeVisible();
    await expect(row(page).getByText(/Auto-update (on|off)/)).toHaveCount(0);
  });

  test('where it cannot apply the box is aria-disabled with the reason, still focusable, and sends nothing', async ({
    page,
  }) => {
    const state = {
      pr: makePR(
        {
          enabled: false,
          source: 'repo',
          unavailable: {
            code: 'draft',
            reason:
              'A draft pull request is never updated automatically: its branch is still being worked on.',
          },
        },
        { draft: true },
      ),
      posts: [] as Record<string, unknown>[],
    };
    await serve(page, state);
    await page.goto('/pull-requests.html');
    const dialog = await openActionsDialog(row(page));
    const box = dialog.getByRole('checkbox', {
      name: 'Update this branch automatically',
    });

    await expect(box).toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByText(/never updated automatically/)).toBeVisible();
    await expect(box).toHaveAccessibleDescription(
      /never updated automatically/,
    );
    await box.focus();
    await expect(box).toBeFocused();
    await box.click({ force: true });

    await expect(box).not.toBeChecked();
    expect(state.posts).toEqual([]);
  });

  test('a refused change says so in the dialog and leaves the box as the server has it', async ({
    page,
  }) => {
    await serve(page, {
      pr: makePR(FOLLOWS_REPO_ON),
      posts: [],
      respond: () => null,
    });
    await page.goto('/pull-requests.html');
    const dialog = await openActionsDialog(row(page));
    const box = dialog.getByRole('checkbox', {
      name: 'Update this branch automatically',
    });

    await box.uncheck();

    await expect(
      dialog.getByText(
        /Couldn't change automatic updates for alrayyes\/forge-dashboard#42/,
      ),
    ).toBeVisible();
    await expect(box).toBeChecked();
  });

  for (const theme of ['light', 'dark']) {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 800 },
    ]) {
      test(`has no axe-core violations with the box on, own choice and unavailable, ${theme} at ${viewport.width}px`, async ({
        page,
        context,
        baseURL,
      }) => {
        await context.addCookies([
          { name: 'forge-board-theme', value: theme, url: baseURL ?? '' },
        ]);
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const states: AutoUpdate[] = [
          FOLLOWS_REPO_ON,
          { enabled: false, source: 'pullRequest', unavailable: null },
          {
            enabled: false,
            source: 'repo',
            unavailable: {
              code: 'release_please',
              reason:
                'A release-please pull request is never updated automatically: release-please rewrites its own branch with every release.',
            },
          },
        ];
        for (const autoUpdate of states) {
          await page.unroute('**/api/dashboard*').catch(() => {});
          await page.unroute('**/api/dashboard/refresh*').catch(() => {});
          await serve(page, { pr: makePR(autoUpdate), posts: [] });
          await page.goto('/pull-requests.html');
          const dialog = await openActionsDialog(row(page));
          await expect(
            dialog.getByRole('checkbox', {
              name: 'Update this branch automatically',
            }),
          ).toBeVisible();
          expect(
            (await new AxeBuilder({ page }).withTags(TAGS).analyze())
              .violations,
          ).toEqual([]);
        }
      });
    }
  }
});
