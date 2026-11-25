/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { boardNeedsSetup } from './setup-gate';

const unlinked = {
  refreshed: true,
  github: {
    configured: true,
    installUrl: '',
    authorized: false,
    account: '',
    installations: [],
    installationsUnavailable: false,
    repositoryCount: 0,
  },
  forgejo: {
    redirectUri: '',
    scopes: [],
    instanceUrl: '',
    linked: false,
    account: '',
    repositoryCount: 0,
    reachable: true,
  },
};

function answering(setup: unknown, settings: unknown = {}, ok = true) {
  return async (url: string) =>
    new Response(JSON.stringify(url === '/api/v1/setup' ? setup : settings), {
      status: url === '/api/v1/setup' || ok ? 200 : 500,
    });
}

describe('boardNeedsSetup', () => {
  test('nothing linked and no saved token: yes', async () => {
    expect(await boardNeedsSetup(answering(unlinked))).toBe(true);
  });

  test('a linked Forgejo: no', async () => {
    const linked = {
      ...unlinked,
      forgejo: { ...unlinked.forgejo, linked: true },
    };
    expect(await boardNeedsSetup(answering(linked))).toBe(false);
  });

  test('a token saved before the OAuth sign-in keeps its owner out of setup', async () => {
    expect(
      await boardNeedsSetup(answering(unlinked, { forgejoTokenSet: true })),
    ).toBe(false);
    expect(
      await boardNeedsSetup(
        answering(unlinked, { githubAppInstallationId: 7 }),
      ),
    ).toBe(false);
  });

  test('an answer that is not the setup facts, or a failure: no', async () => {
    expect(await boardNeedsSetup(answering({ pullRequests: [] }))).toBe(false);
    expect(
      await boardNeedsSetup(async () => {
        throw new Error('offline');
      }),
    ).toBe(false);
  });
});
