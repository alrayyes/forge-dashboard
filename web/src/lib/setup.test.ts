/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  continueState,
  forgejoView,
  githubView,
  installRows,
  isLinked,
  parseSetupQuery,
  readSetupFacts,
  type SetupFacts,
  setupErrorMessage,
  UNKNOWN_ERROR_MESSAGE,
} from './setup';

// What the page derives from the server's facts (#4026). The server never says
// which step is current or whether Continue is open; these tests pin that.

const empty: SetupFacts = {
  refreshed: true,
  github: {
    configured: true,
    installUrl: 'https://github.com/apps/demo/installations/new',
    authorized: false,
    account: '',
    installations: [],
    installationsUnavailable: false,
    repositoryCount: 0,
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

function withGitHub(patch: Partial<SetupFacts['github']>, refreshed = true) {
  return { ...empty, refreshed, github: { ...empty.github, ...patch } };
}

function withForgejo(patch: Partial<SetupFacts['forgejo']>, refreshed = true) {
  return { ...empty, refreshed, forgejo: { ...empty.forgejo, ...patch } };
}

const authorized = { authorized: true, account: 'octo-demo' };
const installed = {
  installations: [{ id: 1, accountLogin: 'octo-demo', saved: true }],
};

describe('error codes', () => {
  test('a known code has its own sentence', () => {
    expect(setupErrorMessage('access_denied')).toContain('cancelled or denied');
  });

  test('every code the API lists has a sentence of its own', () => {
    for (const code of [
      'access_denied',
      'invalid_state',
      'exchange_failed',
      'account_unreadable',
      'save_failed',
      'not_connected',
      'installation_unverified',
      'installations_unavailable',
    ]) {
      expect(setupErrorMessage(code)).not.toBe(UNKNOWN_ERROR_MESSAGE);
    }
  });

  test('a code the table has never heard of falls back, and so do prototype names', () => {
    expect(setupErrorMessage('brand_new_code')).toBe(UNKNOWN_ERROR_MESSAGE);
    expect(setupErrorMessage('constructor')).toBe(UNKNOWN_ERROR_MESSAGE);
    expect(setupErrorMessage('')).toBe(UNKNOWN_ERROR_MESSAGE);
  });

  test('the query is read for an error and for a pending install request', () => {
    expect(parseSetupQuery('?error=access_denied')).toEqual({
      error: 'access_denied',
      installRequested: false,
    });
    expect(parseSetupQuery('?install=requested').installRequested).toBe(true);
    expect(parseSetupQuery('?install=other').installRequested).toBe(false);
    expect(parseSetupQuery('')).toEqual({ error: '', installRequested: false });
  });
});

describe('GitHub steps', () => {
  test('nothing authorized: step 1 is current', () => {
    const v = githubView(empty);
    expect(v.steps).toEqual(['current', 'todo', 'todo']);
    expect(v.current).toBe(1);
    expect(v.ready).toBe(false);
  });

  test('authorized but not installed: step 2 is current', () => {
    const v = githubView(withGitHub(authorized));
    expect(v.steps).toEqual(['done', 'current', 'todo']);
    expect(v.current).toBe(2);
    expect(v.open).toEqual([2, 3]);
  });

  test('the signed-in account gets a Not installed row', () => {
    const rows = installRows(withGitHub(authorized).github, false);
    expect(rows).toEqual([
      {
        key: 'own',
        account: 'octo-demo',
        state: 'not-installed',
        organization: false,
      },
    ]);
  });

  test('a request waiting on an organization owner shows as waiting', () => {
    const rows = installRows(withGitHub(authorized).github, true);
    expect(rows.map((r) => r.state)).toEqual(['not-installed', 'waiting']);
  });

  test('installed with repositories is ready, one row per account', () => {
    const facts = withGitHub({
      ...authorized,
      ...installed,
      repositoryCount: 12,
    });
    const v = githubView(facts);
    expect(v.steps).toEqual(['done', 'done', 'done']);
    expect(v.ready).toBe(true);
    expect(v.repos).toBe('ready');
    expect(installRows(facts.github, false)[0]?.state).toBe('connected');
  });

  test('installed and refreshed with none visible is the no-repositories state', () => {
    const v = githubView(withGitHub({ ...authorized, ...installed }));
    expect(v.repos).toBe('none');
    expect(v.steps).toEqual(['done', 'done', 'current']);
    expect(v.ready).toBe(false);
  });

  test('zero before the first refresh means not known yet, not none', () => {
    const v = githubView(withGitHub({ ...authorized, ...installed }, false));
    expect(v.repos).toBe('counting');
    expect(v.ready).toBe(true);
  });

  test('an installation that is not saved does not count', () => {
    const v = githubView(
      withGitHub({
        ...authorized,
        installations: [{ id: 2, accountLogin: 'octo-demo', saved: false }],
      }),
    );
    expect(v.current).toBe(2);
  });
});

describe('Forgejo steps', () => {
  test('not linked: step 1 is current and repositories are blocked', () => {
    const v = forgejoView(empty);
    expect(v.steps).toEqual(['current', 'todo', 'todo']);
    expect(v.repos).toBe('blocked');
  });

  test('linked with zero repositories after a refresh is the no-repositories state', () => {
    const v = forgejoView(withForgejo({ linked: true, account: 'demo' }));
    expect(v.repos).toBe('none');
    expect(v.ready).toBe(false);
  });

  test('linked with repositories is ready', () => {
    const v = forgejoView(
      withForgejo({ linked: true, account: 'demo', repositoryCount: 4 }),
    );
    expect(v.ready).toBe(true);
  });
});

describe('Continue', () => {
  test('shut, with a hint that says what to do, when nothing is linked', () => {
    const c = continueState(empty);
    expect(c.enabled).toBe(false);
    expect(c.hint).toContain('GitHub or Forgejo');
  });

  test('shut, naming the steps left on the forge that was started', () => {
    expect(continueState(withGitHub(authorized)).hint).toBe(
      'Finish steps 2 and 3 for GitHub, or set up Forgejo.',
    );
    expect(
      continueState(withForgejo({ linked: true, account: 'demo' })).hint,
    ).toBe('Finish step 3 for Forgejo, or set up GitHub.');
  });

  test('open when either forge is at its last step', () => {
    expect(
      continueState(
        withGitHub({ ...authorized, ...installed, repositoryCount: 3 }),
      ),
    ).toEqual({ enabled: true, hint: '' });
    expect(
      continueState(withForgejo({ linked: true, repositoryCount: 1 })).enabled,
    ).toBe(true);
  });
});

describe('the gate', () => {
  test('nothing linked, or only authorized, is not linked', () => {
    expect(isLinked(empty)).toBe(false);
    expect(isLinked(withGitHub(authorized))).toBe(false);
  });

  test('a saved installation or a linked Forgejo is linked', () => {
    expect(isLinked(withGitHub({ ...authorized, ...installed }))).toBe(true);
    expect(isLinked(withForgejo({ linked: true }))).toBe(true);
  });

  test('an answer that is not the setup facts is read as nothing', () => {
    expect(readSetupFacts(null)).toBeNull();
    expect(readSetupFacts({ branches: [] })).toBeNull();
    expect(readSetupFacts(empty)).toEqual(empty);
  });
});
