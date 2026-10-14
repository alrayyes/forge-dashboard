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

test.describe('WebMCP get_dashboard tool', () => {
  // Read-only: no test writes per-user state, so they share one session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('registers get_dashboard when document.modelContext is present', async ({
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
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('get_dashboard');
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
});
