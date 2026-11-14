/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { unconfirmedConflictReason } from './conflict-reason';

describe('unconfirmedConflictReason', () => {
  test('names Update branch only when the row offers it', () => {
    expect(
      unconfirmedConflictReason({ lock: null, updateOffered: true }),
    ).toContain('Use Update branch');
    const without = unconfirmedConflictReason({
      lock: null,
      updateOffered: false,
    });
    expect(without).not.toContain('Update');
    expect(without).toContain('open the pull request on the forge');
  });

  test('an unreachable forge says the row is earlier data and names no action', () => {
    const text = unconfirmedConflictReason({
      lock: { reason: 'x', code: 'forge_unreachable' },
      updateOffered: true,
    });
    expect(text).toContain("isn't answering");
    expect(text).toContain('earlier');
    expect(text).not.toContain('Update');
  });

  test('a spent rate limit says why and names no action', () => {
    const text = unconfirmedConflictReason({
      lock: { reason: 'Rate limit reached.', code: 'rate_limited' },
      updateOffered: true,
    });
    expect(text).toContain('Rate limit reached.');
    expect(text).not.toContain('Update');
  });

  test('a lock from a failed click does not change the words', () => {
    expect(
      unconfirmedConflictReason({
        lock: { reason: 'x', code: 'permission' },
        updateOffered: false,
      }),
    ).toContain('Wait for the forge');
  });
});
