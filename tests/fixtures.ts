import { test as base } from '@playwright/test';
import {
  allowedActionsFor,
  installAllowedActionsStandIn,
} from './allowed-actions-stand-in';

// The test every spec imports. It is Playwright's own, plus one thing: each
// browser context gets the stand-in for the server's `allowedActions` on
// mocked snapshots (see allowed-actions-stand-in.ts, #805).
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(
      `(${installAllowedActionsStandIn.toString()})(${allowedActionsFor.toString()})`,
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
