/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  ApiError,
  checkRegistrationOpen,
  loginFailure,
  loginFailureTracker,
} from './login-flow';

describe('loginFailure', () => {
  test('a 404 while registration is open sends the visitor to register', () => {
    const got = loginFailure(
      new ApiError('no passkey is registered yet', 404),
      true,
    );
    expect(got.action).toBe('register');
  });

  test('says why the page switched', () => {
    const got = loginFailure(
      new ApiError('no passkey is registered yet', 404),
      true,
    );
    expect(got.message).toBe(
      'No passkey is registered yet. Create the first one.',
    );
  });

  test('a 404 while registration is closed is shown as it came', () => {
    const got = loginFailure(
      new ApiError('no passkey is registered yet', 404),
      false,
    );
    expect(got).toEqual({
      action: 'show',
      message: 'no passkey is registered yet',
    });
  });

  test('another status is shown as it came, even with registration open', () => {
    const got = loginFailure(new ApiError('could not start login', 500), true);
    expect(got).toEqual({ action: 'show', message: 'could not start login' });
  });

  test('an error with no message falls back to a generic one', () => {
    expect(loginFailure(new Error(''), true)).toEqual({
      action: 'show',
      message: 'Sign-in failed.',
    });
  });

  const notAllowed = () => {
    const err = new Error('The operation either timed out or was not allowed.');
    err.name = 'NotAllowedError';
    return err;
  };

  test('a first cancel or timeout is a short retry message', () => {
    expect(loginFailure(notAllowed(), false)).toEqual({
      action: 'show',
      message: 'Sign-in was cancelled or timed out. Try again.',
    });
  });

  test('a repeat names the missing passkey and the reset command', () => {
    const got = loginFailure(notAllowed(), false, true);
    expect(got.action).toBe('show');
    expect(got.message).toContain('may have no passkey saved');
    expect(got.message).toContain('forge-dashboard reset-passkeys');
    expect(got.message).toContain('Settings');
  });

  test('a repeat puts the reset command in a sentence of its own', () => {
    const sentences = loginFailure(notAllowed(), false, true).message.split(
      /(?<=\.)\s+/,
    );
    const withCommand = sentences.filter((s) =>
      s.includes('forge-dashboard reset-passkeys'),
    );
    expect(withCommand).toHaveLength(1);
    expect(withCommand[0]).not.toContain(':');
  });
});

describe('loginFailureTracker', () => {
  const notAllowed = () => {
    const err = new Error('timed out');
    err.name = 'NotAllowedError';
    return err;
  };

  test('the first cancelled prompt gets the short retry line', () => {
    const next = loginFailureTracker();
    expect(next(notAllowed(), false).message).toBe(
      'Sign-in was cancelled or timed out. Try again.',
    );
  });

  test('the second cancelled prompt in a row names the reset command', () => {
    const next = loginFailureTracker();
    next(notAllowed(), false);
    expect(next(notAllowed(), false).message).toContain(
      'forge-dashboard reset-passkeys',
    );
  });

  test('a different failure in between starts the count again', () => {
    const next = loginFailureTracker();
    next(notAllowed(), false);
    next(new ApiError('could not start login', 500), false);
    expect(next(notAllowed(), false).message).toBe(
      'Sign-in was cancelled or timed out. Try again.',
    );
  });

  test('the long message keeps showing while prompts keep failing', () => {
    const next = loginFailureTracker();
    next(notAllowed(), false);
    next(notAllowed(), false);
    expect(next(notAllowed(), false).message).toContain(
      'forge-dashboard reset-passkeys',
    );
  });
});

describe('checkRegistrationOpen', () => {
  const answer = (body: unknown, ok = true) =>
    (async () =>
      ({ ok, json: async () => body }) as Response) as unknown as typeof fetch;

  test('is true when the server says registration is open', async () => {
    expect(await checkRegistrationOpen(answer({ open: true }))).toBe(true);
  });

  test('is false when the server says it is closed', async () => {
    expect(await checkRegistrationOpen(answer({ open: false }))).toBe(false);
  });

  test('is false on a failed response', async () => {
    expect(await checkRegistrationOpen(answer({}, false))).toBe(false);
  });

  test('is false when the request throws', async () => {
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await checkRegistrationOpen(down)).toBe(false);
  });
});
