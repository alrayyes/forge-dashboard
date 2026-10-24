/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { ApiError, loginFailure } from './login-flow';

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

  test('a repeat keeps the long message short enough to read at a glance', () => {
    expect(loginFailure(notAllowed(), false, true).message.length).toBeLessThan(
      260,
    );
  });
});
