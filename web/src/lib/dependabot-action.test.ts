/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  type DependabotButtonInput,
  dependabotActionKey,
  dependabotButtonDecision,
  dependabotPendingReason,
} from './dependabot-action';

const KEY = 'github:alrayyes/forge-dashboard#42';
const NO_PROACTIVE = null;

function input(
  over: Partial<DependabotButtonInput> = {},
): DependabotButtonInput {
  return {
    prKey: KEY,
    action: 'rebase',
    states: {},
    blockedReason: undefined,
    serverEntry: () => undefined,
    proactive: () => NO_PROACTIVE,
    confirmingRecreate: false,
    printReason: false,
    ...over,
  };
}

describe('dependabotButtonDecision', () => {
  test('an untouched pull request gets a plain button for each action', () => {
    expect(dependabotButtonDecision(input({ action: 'rebase' }))).toEqual({
      kind: 'button',
      queued: false,
    });
    expect(dependabotButtonDecision(input({ action: 'recreate' }))).toEqual({
      kind: 'button',
      queued: false,
    });
  });

  test('a permission failure on Rebase locks Rebase only, and Recreate stays usable', () => {
    const states = {
      [dependabotActionKey(KEY, 'rebase')]: {
        phase: 'locked',
        reason: 'Missing permission — check your token in Settings.',
        code: 'permission',
      },
    };
    expect(
      dependabotButtonDecision(input({ action: 'rebase', states })),
    ).toEqual({
      kind: 'locked',
      lock: {
        reason: 'Missing permission — check your token in Settings.',
        code: 'permission',
      },
      printNote: false,
    });
    expect(
      dependabotButtonDecision(input({ action: 'recreate', states })),
    ).toEqual({ kind: 'button', queued: false });
  });

  test('a lock on one pull request leaves another pull request alone', () => {
    const states = {
      [dependabotActionKey(KEY, 'rebase')]: {
        phase: 'locked',
        reason: 'no',
        code: 'permission',
      },
    };
    expect(
      dependabotButtonDecision(
        input({ prKey: 'github:alrayyes/other#7', action: 'rebase', states }),
      ),
    ).toEqual({ kind: 'button', queued: false });
  });

  test('a GitHub App with no personal token locks both buttons with the reason', () => {
    const reason = 'Save a personal access token in Settings.';
    for (const action of ['rebase', 'recreate'] as const) {
      expect(
        dependabotButtonDecision(input({ action, blockedReason: reason })),
      ).toEqual({ kind: 'locked', lock: reason, printNote: false });
    }
  });

  test('the missing-token lock wins over a button the page had queued', () => {
    const states = {
      [dependabotActionKey(KEY, 'rebase')]: { phase: 'queued' },
    };
    expect(
      dependabotButtonDecision(input({ states, blockedReason: 'no token' }))
        .kind,
    ).toBe('locked');
  });

  test('a queued Recreate locks Rebase, naming Recreate', () => {
    const states = {
      [dependabotActionKey(KEY, 'recreate')]: { phase: 'queued' },
    };
    expect(
      dependabotButtonDecision(input({ action: 'rebase', states })),
    ).toEqual({
      kind: 'locked',
      lock: 'A Dependabot Recreate is pending on this pull request.',
      printNote: false,
    });
  });

  test('the dialog prints the reason beside a pending lock', () => {
    const states = {
      [dependabotActionKey(KEY, 'rebase')]: { phase: 'rebasing' },
    };
    expect(
      dependabotButtonDecision(
        input({ action: 'recreate', states, printReason: true }),
      ),
    ).toEqual({
      kind: 'locked',
      lock: 'A Dependabot Rebase is pending on this pull request.',
      printNote: true,
    });
  });

  test('a request the server already holds locks the action with its message', () => {
    expect(
      dependabotButtonDecision(
        input({
          serverEntry: () => ({
            blocked: { code: 'already_requested', message: 'Already asked.' },
          }),
        }),
      ),
    ).toEqual({ kind: 'locked', lock: 'Already asked.', printNote: false });
  });

  test('the forge-wide lock and the server entry are looked up only for an idle action', () => {
    let asked = 0;
    let looked = 0;
    const proactive = () => {
      asked++;
      return null;
    };
    const serverEntry = () => {
      looked++;
      return undefined;
    };
    dependabotButtonDecision(
      input({ blockedReason: 'no token', proactive, serverEntry }),
    );
    dependabotButtonDecision(
      input({
        states: { [dependabotActionKey(KEY, 'rebase')]: { phase: 'locked' } },
        proactive,
        serverEntry,
      }),
    );
    dependabotButtonDecision(
      input({
        states: { [dependabotActionKey(KEY, 'rebase')]: { phase: 'queued' } },
        proactive,
        serverEntry,
      }),
    );
    expect(asked).toBe(0);
    expect(looked).toBe(0);
    dependabotButtonDecision(input({ proactive, serverEntry }));
    expect(asked).toBe(1);
    expect(looked).toBe(1);
  });

  test('a spent rate limit draws nothing, and another proactive lock draws a locked button', () => {
    expect(
      dependabotButtonDecision(
        input({ proactive: () => ({ reason: 'spent', code: 'rate_limited' }) }),
      ),
    ).toEqual({ kind: 'hidden' });
    expect(
      dependabotButtonDecision(
        input({
          proactive: () => ({
            reason: 'unreachable',
            code: 'forge_unreachable',
          }),
        }),
      ),
    ).toEqual({ kind: 'hidden' });
    expect(
      dependabotButtonDecision(
        input({ proactive: () => ({ reason: 'other', code: 'something' }) }),
      ),
    ).toEqual({
      kind: 'locked',
      lock: { reason: 'other', code: 'something' },
      printNote: false,
    });
    expect(
      dependabotButtonDecision(
        input({
          proactive: () => ({ reason: 'other', code: 'something' }),
          printReason: true,
        }),
      ),
    ).toEqual({
      kind: 'locked',
      lock: { reason: 'other', code: 'something' },
      printNote: true,
    });
  });

  test('Recreate shows its confirm step while armed, Rebase never does', () => {
    expect(
      dependabotButtonDecision(
        input({ action: 'recreate', confirmingRecreate: true }),
      ),
    ).toEqual({ kind: 'confirm' });
    expect(
      dependabotButtonDecision(
        input({ action: 'rebase', confirmingRecreate: true }),
      ).kind,
    ).toBe('button');
  });

  test('a queued or rebasing request draws a pending button', () => {
    for (const phase of ['queued', 'rebasing']) {
      const states = { [dependabotActionKey(KEY, 'rebase')]: { phase } };
      expect(dependabotButtonDecision(input({ states }))).toEqual({
        kind: 'button',
        queued: true,
      });
    }
  });
});

describe('dependabotPendingReason', () => {
  test('is undefined with nothing pending', () => {
    expect(
      dependabotPendingReason(KEY, 'rebase', {}, undefined),
    ).toBeUndefined();
  });

  test('ignores a server entry blocked for any other reason', () => {
    expect(
      dependabotPendingReason(
        KEY,
        'rebase',
        {},
        {
          blocked: { code: 'permission', message: 'nope' },
        },
      ),
    ).toBeUndefined();
  });
});
