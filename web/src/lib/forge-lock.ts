// Whether a forge would only refuse a write: it can't be reached, or its REST
// budget is spent. The pull request board and the Main branches page lock a
// control on this, with the same wording, instead of letting a click fail.

import { FORGE_LABELS } from './forges';
import {
  isRateLimited,
  type RateLimit,
  rateLimitReasonText,
} from './rate-limit';

export type ForgeHealthEntry = {
  forge: string;
  reachable: boolean;
  rateLimitREST?: RateLimit;
  rateLimitGraphQL?: RateLimit;
};

export type ForgeLock = {
  code: 'forge_unreachable' | 'rate_limited';
  reason: string;
};

export function forgeLockReason(
  forges: readonly ForgeHealthEntry[] | undefined,
  forge: string,
  now: number = Date.now(),
): ForgeLock | null {
  const health = forges?.find((f) => f.forge === forge);
  if (!health) return null;
  if (health.reachable === false)
    return {
      code: 'forge_unreachable',
      reason: "This forge can't be reached right now.",
    };
  const spent = health.rateLimitREST;
  if (isRateLimited(spent, now))
    return {
      code: 'rate_limited',
      reason: rateLimitReasonText(
        FORGE_LABELS[forge] || forge,
        spent.resetsAt,
        now,
      ),
    };
  return null;
}
