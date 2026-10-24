/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  type DependabotButtonInput,
  dependabotActionKey,
  dependabotButtonDecision,
  dependabotServerLock,
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

  // The command just sent keeps its pending button until the server lists the
  // request; the other command is not drawn meanwhile.
  for (const sent of ['rebase', 'recreate'] as const) {
    for (const phase of ['queued', 'rebasing']) {
      test(`a ${phase} ${sent} keeps its pending button and hides the other`, () => {
        const states = { [dependabotActionKey(KEY, sent)]: { phase } };
        const other = sent === 'rebase' ? 'recreate' : 'rebase';
        expect(
          dependabotButtonDecision(input({ action: sent, states })),
        ).toEqual({ kind: 'button', queued: true });
        expect(
          dependabotButtonDecision(input({ action: other, states })),
        ).toEqual({ kind: 'hidden' });
      });
    }
  }

  test('a pending command on another pull request leaves this one alone', () => {
    const states = {
      [dependabotActionKey('github:alrayyes/other#7', 'rebase')]: {
        phase: 'queued',
      },
    };
    expect(dependabotButtonDecision(input({ states }))).toEqual({
      kind: 'button',
      queued: false,
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
});

describe('dependabotServerLock', () => {
  test('is undefined with no server entry or no block', () => {
    expect(dependabotServerLock(undefined)).toBeUndefined();
    expect(dependabotServerLock({})).toBeUndefined();
  });

  test('gives the message of a server entry blocked for any reason', () => {
    expect(
      dependabotServerLock({
        blocked: {
          code: 'blocked_by_protection',
          message: 'Workflow runs are waiting for approval',
        },
      }),
    ).toBe('Workflow runs are waiting for approval');
  });
});
