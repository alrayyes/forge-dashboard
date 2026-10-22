// Whether a forge would only refuse a write: it can't be reached, or the
// budget the write spends is gone. The pull request board and the Main
// branches page lock a control on this, with the same wording, instead of
// letting a click fail.

import { FORGE_LABELS } from './forges';
import {
  isRateLimited,
  type RateLimit,
  rateLimitReasonText,
} from './rate-limit';

// The part of a forge's health this reads; the dashboard's and the Main
// branches responses both carry entries of this shape.
export type ForgeHealthEntry = {
  forge: string;
  reachable: boolean;
  rateLimitREST?: RateLimit;
  rateLimitGraphQL?: RateLimit;
  // Why Dependabot would refuse a command through this credential.
  dependabotCommandsBlocked?: string;
};

export type ForgeLock = {
  code: 'forge_unreachable' | 'rate_limited';
  reason: string;
  // When a rate limit lifts, so a caller can look again then.
  resetsAt?: string;
};

function lockOf(
  health: ForgeHealthEntry,
  budget: 'rest' | 'graphql',
  now: number,
): ForgeLock | null {
  if (health.reachable === false)
    return {
      code: 'forge_unreachable',
      reason: "This forge can't be reached right now.",
    };
  const spent =
    budget === 'rest' ? health.rateLimitREST : health.rateLimitGraphQL;
  if (!isRateLimited(spent, now)) return null;
  return {
    code: 'rate_limited',
    reason: rateLimitReasonText(
      FORGE_LABELS[health.forge] || health.forge,
      spent.resetsAt,
      now,
    ),
    resetsAt: spent.resetsAt,
  };
}

// A row names its forge kind, not the host, so with several entries of one
// kind the control is locked only when every one of them would refuse it.
export function forgeLockReason(
  forges: readonly ForgeHealthEntry[] | undefined,
  forge: string,
  now: number = Date.now(),
  budget: 'rest' | 'graphql' = 'rest',
): ForgeLock | null {
  const locks = (forges ?? [])
    .filter((f) => f.forge === forge)
    .map((f) => lockOf(f, budget, now));
  if (locks.length === 0 || locks.some((l) => l === null)) return null;
  // All of them refuse. The one to report is the rate limit that lifts first,
  // since that is when a host frees up; unreachable hosts have no such time.
  const limited = locks
    .filter((l): l is ForgeLock => l?.resetsAt !== undefined)
    .sort(
      (a, b) => Date.parse(a.resetsAt ?? '') - Date.parse(b.resetsAt ?? ''),
    );
  return limited[0] ?? locks[0];
}

// The first limit of one budget that is still ahead among the hosts of a
// kind, for the wording of a refusal that came without its own reset time.
// Only the budget the action spends counts: a GraphQL reset says nothing
// about a REST refusal.
export function spentLimit(
  forges: readonly ForgeHealthEntry[] | undefined,
  forge: string,
  budget: 'rest' | 'graphql',
  now: number = Date.now(),
): RateLimit | undefined {
  return (forges ?? [])
    .filter((f) => f.forge === forge)
    .map((f) => (budget === 'rest' ? f.rateLimitREST : f.rateLimitGraphQL))
    .find((l): l is RateLimit => !!l && Date.parse(l.resetsAt) > now);
}

// Why Dependabot commands are refused through a kind's credential, or nothing.
// Rows name the kind, so it holds only when there is a host and every host of
// the kind is blocked; the first host's reason stands for them all.
export function dependabotBlockedReason(
  forges: readonly ForgeHealthEntry[] | undefined,
  forge: string,
): string | undefined {
  const hosts = (forges ?? []).filter((f) => f.forge === forge);
  return hosts.length > 0 && hosts.every((f) => f.dependabotCommandsBlocked)
    ? hosts[0].dependabotCommandsBlocked
    : undefined;
}
