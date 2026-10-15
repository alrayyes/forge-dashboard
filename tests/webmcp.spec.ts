import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

interface WebMCPTool {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

declare global {
  interface Window {
    __webmcpTools: WebMCPTool[];
  }
  interface Document {
    modelContext?: {
      registerTool(tool: WebMCPTool): Promise<void>;
    };
  }
}

// Playwright's own bundled Chromium doesn't implement document.modelContext
// -- WebMCP is still Chrome/Edge Origin Trial only as of this writing (see
// README's Design section), and confirmed live: a real page.evaluate() check
// against it here comes back undefined. There's no way to exercise the
// browser's own tool-discovery/execution mediation in this suite. What IS
// testable, and what this file covers: that the page's own code registers
// the right tool with the right shape when document.modelContext exists at
// all, and that calling its execute() callback (standing in for what the
// browser would do on an agent's behalf) does the right thing -- fetches
// real data through the same /api/dashboard endpoint the page's own poll
// already uses, not a parallel path.
async function stubModelContext(page: Page) {
  await page.addInitScript(() => {
    window.__webmcpTools = [];
    // A minimal stand-in for the real WebMCP interface -- just enough
    // surface for +page.svelte's own registerTool() call to succeed and
    // be observable from the test.
    document.modelContext = {
      registerTool(tool: WebMCPTool) {
        window.__webmcpTools.push(tool);

        return Promise.resolve();
      },
    };
  });
}

test.describe('WebMCP tools', () => {
  // Read-only: no test writes per-user state, so they share one session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('registers its tools when document.modelContext is present', async ({
    page,
  }) => {
    await stubModelContext(page);
    await page.goto('/pull-requests.html');

    // Registration happens once the dashboard's own script runs past its
    // initial setup, not necessarily by the moment navigation itself
    // settles -- waitForFunction polls rather than racing a one-shot
    // check against that gap.
    await page.waitForFunction(() => window.__webmcpTools.length > 0);

    const tools = await page.evaluate(() => window.__webmcpTools);
    expect(tools.map((t) => t.name)).toEqual([
      'get_dashboard',
      'get_main_branches',
      'get_pull_request_checks',
      'get_pull_request_details',
    ]);
    expect(tools[0].description).toMatch(/pull requests/i);
  });

  test('registering it never breaks the page when document.modelContext is absent -- every browser but an Origin Trial one today', async ({
    page,
  }) => {
    // No stub here -- this is the real, current-browser-default case.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/pull-requests.html');

    await expect(page.locator('h1')).toHaveText('Forge Board');
    expect(
      errors,
      'registering threw on a browser without modelContext',
    ).toEqual([]);
  });

  test("get_dashboard's execute() fetches real data through the same /api/dashboard endpoint the page's own poll uses", async ({
    page,
  }) => {
    await stubModelContext(page);
    await page.goto('/pull-requests.html');
    await page.waitForFunction(() => window.__webmcpTools.length > 0);

    const [response, result] = await Promise.all([
      page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === '/api/dashboard' &&
          res.request().method() === 'GET',
      ),
      page.evaluate(() => {
        const tool = window.__webmcpTools.find(
          (t) => t.name === 'get_dashboard',
        );

        if (!tool) throw new Error('get_dashboard tool not registered');

        return tool.execute({});
      }),
    ]);

    expect(response.status()).toBe(200);
    expect(result).toHaveProperty('pullRequests');
    expect(result).toHaveProperty('forges');
    expect(result).toHaveProperty('generatedAt');
  });

  // The read tools with a server twin (#1503): each calls the endpoint the
  // tool is named for and returns that endpoint's JSON untouched.
  const PR = { forge: 'forgejo', fullName: 'acme/api', number: 7 };
  const PR_QUERY = 'forge=forgejo&fullName=acme%2Fapi&number=7';
  const readTools = [
    { tool: 'get_main_branches', input: {}, path: '/api/main-branches' },
    {
      tool: 'get_pull_request_checks',
      input: PR,
      path: '/api/pull-requests/checks',
      query: PR_QUERY,
    },
    {
      tool: 'get_pull_request_details',
      input: PR,
      path: '/api/pull-requests/details',
      query: PR_QUERY,
    },
  ];

  for (const { tool, input, path, query } of readTools) {
    test(`${tool} calls ${path} and returns its JSON`, async ({ page }) => {
      const body = { marker: tool };
      const seen: string[] = [];
      await page.route(`**${path}*`, (route) => {
        seen.push(new URL(route.request().url()).search.slice(1));

        return route.fulfill({ json: body });
      });
      await stubModelContext(page);
      await page.goto('/pull-requests.html');
      await page.waitForFunction(() => window.__webmcpTools.length > 0);

      const result = await page.evaluate(
        ({ name, args }) => {
          const t = window.__webmcpTools.find((x) => x.name === name);
          if (!t) throw new Error(`${name} tool not registered`);

          return t.execute(args);
        },
        { name: tool, args: input },
      );

      expect(result).toEqual(body);
      expect(seen).toEqual([query ?? '']);
    });
  }
});
