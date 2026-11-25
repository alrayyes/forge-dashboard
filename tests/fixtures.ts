import { test as base } from '@playwright/test';
import {
  allowedActionsFixture,
  installAllowedActionsStandIn,
  outputFor,
} from './allowed-actions-stand-in';

export const linkedSetupFacts = {
  refreshed: true,
  github: {
    configured: true,
    installUrl: 'https://github.com/apps/demo/installations/new',
    authorized: true,
    account: 'octo-demo',
    installations: [{ id: 1, accountLogin: 'octo-demo', saved: true }],
    installationsUnavailable: false,
    repositoryCount: 3,
  },
  forgejo: {
    redirectUri:
      'https://board.example.com/api/v1/connections/forgejo/callback',
    scopes: ['read:user'],
    instanceUrl: '',
    linked: false,
    account: '',
    repositoryCount: 0,
    reachable: true,
  },
};

// The test every spec imports. It is Playwright's own, plus one thing: each
// browser context gets the stand-in for the server's `allowedActions` on
// mocked snapshots (see allowed-actions-stand-in.ts, #805), and an answer for
// GET /api/v1/setup that says a forge is linked. The test server has none, and
// a board with none sends every page to /setup (#4026); a spec about that page
// installs its own route, which wins over this one.
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(
      `(${installAllowedActionsStandIn.toString()})(${JSON.stringify(allowedActionsFixture)}, ${outputFor.toString()})`,
    );
    await context.route(
      (url) => url.pathname === '/api/v1/setup',
      (route) => route.fulfill({ json: linkedSetupFacts }),
    );
    await use(context);
  },
});

export type {
  APIRequestContext,
  Locator,
  Page,
  Route,
} from '@playwright/test';
export { expect } from '@playwright/test';
