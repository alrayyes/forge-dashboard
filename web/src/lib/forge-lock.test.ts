/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';

// rate-limit.ts reaches the timezone store, which needs the Svelte compiler.
mock.module('./time.svelte', () => ({ formatTime: (t: string) => t }));
const { forgeLockReason, spentLimit } = await import('./forge-lock');

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
    expect(forgeLockReason([host()], 'github', NOW)).toBeNull();
    expect(forgeLockReason([host()], 'forgejo', NOW)).toBeNull();
    expect(forgeLockReason(undefined, 'github', NOW)).toBeNull();
  });

  test('an unreachable host locks, and an entry silent on reachability does not', () => {
    expect(
      forgeLockReason([host({ reachable: false })], 'github', NOW)?.code,
    ).toBe('forge_unreachable');
    expect(
      forgeLockReason([{ forge: 'github' } as never], 'github', NOW),
    ).toBeNull();
  });

  test('a spent budget locks until its reset, then no longer', () => {
    const forges = [host({ rateLimitREST: spent('2026-10-22T12:30:00Z') })];
    const lock = forgeLockReason(forges, 'github', NOW);
    expect(lock?.code).toBe('rate_limited');
    expect(lock?.resetsAt).toBe('2026-10-22T12:30:00Z');
    expect(forgeLockReason(forges, 'github', NOW + 31 * 60_000)).toBeNull();
  });

  test('REST and GraphQL are judged on their own budget', () => {
    const forges = [host({ rateLimitGraphQL: spent('2026-10-22T12:30:00Z') })];
    expect(forgeLockReason(forges, 'github', NOW, 'rest')).toBeNull();
    expect(forgeLockReason(forges, 'github', NOW, 'graphql')?.code).toBe(
      'rate_limited',
    );
  });

  test('with several hosts it locks only when all refuse, and reports the earliest reset', () => {
    const late = host({ rateLimitREST: spent('2026-10-22T14:00:00Z') });
    const early = host({ rateLimitREST: spent('2026-10-22T12:10:00Z') });
    expect(forgeLockReason([late, host()], 'github', NOW)).toBeNull();
    expect(forgeLockReason([late, early], 'github', NOW)?.resetsAt).toBe(
      '2026-10-22T12:10:00Z',
    );
  });

  test('a rate limit outranks an unreachable host in the report', () => {
    const lock = forgeLockReason(
      [
        host({ reachable: false }),
        host({ rateLimitREST: spent('2026-10-22T12:10:00Z') }),
      ],
      'github',
      NOW,
    );
    expect(lock?.code).toBe('rate_limited');
  });
});

describe('spentLimit', () => {
  const rest = spent('2026-10-22T12:10:00Z');
  const graphql = spent('2026-10-22T13:00:00Z');

  test('reads only the budget it is asked for', () => {
    const forges = [host({ rateLimitREST: rest, rateLimitGraphQL: graphql })];
    expect(spentLimit(forges, 'github', 'rest', NOW)).toBe(rest);
    expect(spentLimit(forges, 'github', 'graphql', NOW)).toBe(graphql);
    expect(
      spentLimit([host({ rateLimitGraphQL: graphql })], 'github', 'rest', NOW),
    ).toBeUndefined();
  });

  test('skips a limit that has passed, and other forges', () => {
    const forges = [
      host({ rateLimitREST: spent('2026-10-22T11:00:00Z') }),
      { ...host({ rateLimitREST: graphql }), forge: 'forgejo' },
      host({ rateLimitREST: rest }),
    ];
    expect(spentLimit(forges, 'github', 'rest', NOW)).toBe(rest);
  });
});
