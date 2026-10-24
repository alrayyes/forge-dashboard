/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';

// rate-limit.ts reaches the timezone store, which needs the Svelte compiler.
mock.module('./time.svelte', () => ({ formatTime: (t: string) => t }));
const {
  dependabotBlockedReason,
  forgeLockReason,
  rerunBlockedLock,
  spentLimit,
} = await import('./forge-lock');

const NOW = Date.parse('2026-10-22T12:00:00Z');
const spent = (resetsAt: string) => ({
  limit: 5000,
  remaining: 0,
  resetsAt,
  severity: 'exceeded' as const,
});
const host = (over: Record<string, unknown> = {}) => ({
  forge: 'github',
  reachable: true,
  ...over,
});

describe('forgeLockReason', () => {
  test('a healthy host, or none of that kind, is not locked', () => {
    expect(forgeLockReason([host()], 'github', { now: NOW })).toBeNull();
    expect(forgeLockReason([host()], 'forgejo', { now: NOW })).toBeNull();
    expect(forgeLockReason(undefined, 'github', { now: NOW })).toBeNull();
  });

  test('an unreachable host locks, and an entry silent on reachability does not', () => {
    expect(
      forgeLockReason([host({ reachable: false })], 'github', { now: NOW })
        ?.code,
    ).toBe('forge_unreachable');
    expect(
      forgeLockReason([{ forge: 'github' } as never], 'github', { now: NOW }),
    ).toBeNull();
  });

  test('a spent budget locks until its reset, then no longer', () => {
    const forges = [host({ rateLimitREST: spent('2026-10-22T12:30:00Z') })];
    const lock = forgeLockReason(forges, 'github', { now: NOW });
    expect(lock?.code).toBe('rate_limited');
    expect(lock?.resetsAt).toBe('2026-10-22T12:30:00Z');
    expect(
      forgeLockReason(forges, 'github', { now: NOW + 31 * 60_000 }),
    ).toBeNull();
  });

  test('REST and GraphQL are judged on their own budget', () => {
    const forges = [host({ rateLimitGraphQL: spent('2026-10-22T12:30:00Z') })];
    expect(
      forgeLockReason(forges, 'github', { now: NOW, budget: 'rest' }),
    ).toBeNull();
    expect(
      forgeLockReason(forges, 'github', { now: NOW, budget: 'graphql' })?.code,
    ).toBe('rate_limited');
  });

  test('with several hosts it locks only when all refuse, and reports the earliest reset', () => {
    const late = host({ rateLimitREST: spent('2026-10-22T14:00:00Z') });
    const early = host({ rateLimitREST: spent('2026-10-22T12:10:00Z') });
    expect(forgeLockReason([late, host()], 'github', { now: NOW })).toBeNull();
    expect(
      forgeLockReason([late, early], 'github', { now: NOW })?.resetsAt,
    ).toBe('2026-10-22T12:10:00Z');
  });

  test('a rate limit outranks an unreachable host in the report', () => {
    const lock = forgeLockReason(
      [
        host({ reachable: false }),
        host({ rateLimitREST: spent('2026-10-22T12:10:00Z') }),
      ],
      'github',
      { now: NOW },
    );
    expect(lock?.code).toBe('rate_limited');
  });
});

describe('spentLimit', () => {
  const rest = spent('2026-10-22T12:10:00Z');
  const graphql = spent('2026-10-22T13:00:00Z');

  test('reads only the budget it is asked for', () => {
    const forges = [host({ rateLimitREST: rest, rateLimitGraphQL: graphql })];
    expect(spentLimit(forges, 'github', { budget: 'rest', now: NOW })).toBe(
      rest,
    );
    expect(spentLimit(forges, 'github', { budget: 'graphql', now: NOW })).toBe(
      graphql,
    );
    expect(
      spentLimit([host({ rateLimitGraphQL: graphql })], 'github', {
        budget: 'rest',
        now: NOW,
      }),
    ).toBeUndefined();
  });

  test('prefers a budget graded spent, and falls back to a reset still ahead', () => {
    const healthy = {
      ...spent('2026-10-22T13:30:00Z'),
      remaining: 4000,
      severity: 'ok' as const,
    };
    const forges = [
      host({ rateLimitREST: healthy }),
      host({ rateLimitREST: rest }),
    ];
    expect(spentLimit(forges, 'github', { budget: 'rest', now: NOW })).toBe(
      rest,
    );
  });

  test('skips a limit that has passed, and other forges', () => {
    const forges = [
      host({ rateLimitREST: spent('2026-10-22T11:00:00Z') }),
      { ...host({ rateLimitREST: graphql }), forge: 'forgejo' },
      host({ rateLimitREST: rest }),
    ];
    expect(spentLimit(forges, 'github', { budget: 'rest', now: NOW })).toBe(
      rest,
    );
  });
});

describe('dependabotBlockedReason', () => {
  const blocked = (why: string) => host({ dependabotCommandsBlocked: why });

  test('needs a host, and every host of the kind blocked', () => {
    expect(dependabotBlockedReason([], 'github')).toBeUndefined();
    expect(dependabotBlockedReason(undefined, 'github')).toBeUndefined();
    expect(dependabotBlockedReason([blocked('a')], 'github')).toBe('a');
    expect(
      dependabotBlockedReason([blocked('a'), host()], 'github'),
    ).toBeUndefined();
    expect(
      dependabotBlockedReason([blocked('a'), blocked('b')], 'github'),
    ).toBe('a');
  });

  test('ignores hosts of other kinds', () => {
    const other = { ...host(), forge: 'forgejo' };
    expect(dependabotBlockedReason([blocked('a'), other], 'github')).toBe('a');
  });
});

describe('rerunBlockedLock', () => {
  const blocked = (why: string) => host({ rerunChecksBlocked: why });

  test('needs a host, and every host of the kind without a rerun route', () => {
    expect(rerunBlockedLock([], 'github')).toBeNull();
    expect(rerunBlockedLock(undefined, 'github')).toBeNull();
    expect(rerunBlockedLock([host()], 'github')).toBeNull();
    expect(rerunBlockedLock([blocked('a'), host()], 'github')).toBeNull();
    expect(rerunBlockedLock([blocked('a')], 'github')?.reason).toBe('a');
  });

  test('is its own kind of lock, not a rate limit or an outage', () => {
    expect(rerunBlockedLock([blocked('a')], 'github')?.code).toBe(
      'rerun_unsupported',
    );
  });
});

describe('a forge that is still starting up', () => {
  test('locks a write with a reason that says it is loading, not unreachable', () => {
    const lock = forgeLockReason(
      [host({ reachable: false, starting: true })],
      'github',
      { now: NOW },
    );
    expect(lock?.code).toBe('forge_starting');
    expect(lock?.reason).toMatch(/still loading/i);
    expect(lock?.reason).not.toMatch(/try again/i);
    expect(lock?.reason).not.toMatch(/can't be reached/);
  });
});
