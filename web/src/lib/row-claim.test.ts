/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { type ClaimKind, rowClaim } from './row-claim';

const kinds: ClaimKind[] = ['conflict', 'state', 'action'];
const unreachable = { reason: 'x', code: 'forge_unreachable' };
const starting = { reason: 'x', code: 'forge_starting' };
const limited = { reason: 'Rate limit reached.', code: 'rate_limited' };

describe('rowClaim', () => {
  for (const kind of kinds) {
    describe(kind, () => {
      test('confirmed when the forge answered', () => {
        const c = rowClaim({ kind, lock: null });
        expect(c.state).toBe('confirmed');
        expect(c.actionsOpen).toBe(true);
      });

      test.each([
        ['unreachable', unreachable],
        ['starting', starting],
      ])('carried over when the forge is %s', (_n, lock) => {
        const c = rowClaim({ kind, lock, since: '3 min ago' });
        expect(c.state).toBe('carried_over');
        expect(c.actionsOpen).toBe(false);
        expect(c.reason).toContain('3 min ago');
      });

      test('a spent budget closes actions without calling the data old', () => {
        const c = rowClaim({ kind, lock: limited });
        expect(c.state).toBe('confirmed');
        expect(c.actionsOpen).toBe(false);
      });

      test('a lock from a failed click changes nothing', () => {
        const c = rowClaim({ kind, lock: { reason: 'x', code: 'permission' } });
        expect(c.state).toBe('confirmed');
        expect(c.actionsOpen).toBe(true);
      });
    });
  }

  test('a conflict the forge has not confirmed is unknown', () => {
    const c = rowClaim({ kind: 'conflict', lock: null, answered: false });
    expect(c.state).toBe('unknown');
    expect(c.reason).toContain('No merge or update has been refused');
  });

  test('other kinds ignore answered', () => {
    expect(rowClaim({ kind: 'state', lock: null, answered: false }).state).toBe(
      'confirmed',
    );
  });

  test('a carried-over unconfirmed conflict says the rows are earlier data', () => {
    const c = rowClaim({
      kind: 'conflict',
      lock: unreachable,
      answered: false,
      updateOffered: true,
    });
    expect(c.state).toBe('carried_over');
    expect(c.reason).toContain('earlier');
    expect(c.reason).not.toContain('Update');
  });

  test('a spent budget on an unconfirmed conflict names the reset and no action', () => {
    const c = rowClaim({
      kind: 'conflict',
      lock: limited,
      answered: false,
      updateOffered: true,
    });
    expect(c.state).toBe('unknown');
    expect(c.reason).toContain('Rate limit reached.');
    expect(c.reason).not.toContain('Update');
  });

  test('names Update branch only when the row offers it', () => {
    const on = rowClaim({
      kind: 'conflict',
      lock: null,
      answered: false,
      updateOffered: true,
    });
    const off = rowClaim({ kind: 'conflict', lock: null, answered: false });
    expect(on.reason).toContain('Use Update branch');
    expect(off.reason).toContain('open the pull request on the forge');
    expect(off.reason).not.toContain('Update');
  });

  describe('a row that carries its own since-time', () => {
    const staleSince = '2026-01-01T00:00:00Z';
    for (const kind of ['conflict', 'state', 'action'] as ClaimKind[]) {
      test(`${kind} is carried over, with no lock needed`, () => {
        const c = rowClaim({ kind, lock: null, staleSince });
        expect(c.state).toBe('carried_over');
        expect(c.actionsOpen).toBe(false);
        expect(c.reason).not.toBe('');
      });
      test(`${kind} with no since-time is confirmed`, () => {
        for (const staleSince of [null, undefined]) {
          expect(rowClaim({ kind, lock: null, staleSince }).state).toBe(
            'confirmed',
          );
        }
      });
    }

    test('reads the same as a pull request row of an unreachable forge', () => {
      const lock = { reason: 'down', code: 'forge_unreachable' };
      const pr = rowClaim({ kind: 'state', lock, since: '3 min ago' });
      const row = rowClaim({
        kind: 'state',
        lock: null,
        staleSince,
        since: '3 min ago',
      });
      expect(row.reason).toBe(pr.reason);
      expect(row.state).toBe(pr.state);
    });
  });

  test('has no forge in it', async () => {
    const src = await Bun.file(
      new URL('./row-claim.ts', import.meta.url),
    ).text();
    expect(src).not.toMatch(/forgejo|github/i);
  });
});
