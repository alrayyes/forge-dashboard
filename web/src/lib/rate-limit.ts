// A rate limit is a "wait until" condition, not a transient fault: the
// forge says when the budget comes back, so a blocked action shows that
// time and re-enables itself instead of offering a Retry that can't work
// (#732). Pure helpers, no DOM, so the dashboard page stays the only place
// that touches elements.

export type RateLimit = { limit: number; remaining: number; resetsAt: string };

// What kind of wait a lock reason stands for:
// - rate_limit: clears at a known time, no Retry.
// - permission: clears only when the token changes, no Retry.
// - transient: may clear on its own, Retry stays.
export type LockKind = 'rate_limit' | 'permission' | 'transient';

export const PERMISSION_REASON =
  'Missing permission — check your token in Settings.';

const RATE_LIMIT_PATTERN = /rate limit/i;
const PERMISSION_PATTERN = /missing permission|token in settings/i;

export function classifyLockReason(reason: string): LockKind {
  if (RATE_LIMIT_PATTERN.test(reason)) return 'rate_limit';
  if (PERMISSION_PATTERN.test(reason)) return 'permission';
  return 'transient';
}

// A locked action offers Retry only when waiting might fix it.
export function offersRetry(reason: string): boolean {
  return classifyLockReason(reason) === 'transient';
}

// True while the budget is spent and the reset is still ahead. Derived
// from the clock, not stored, so a stale snapshot can't keep an action
// locked past the reset time.
export function isRateLimited(
  limit: RateLimit | undefined,
  now: number = Date.now(),
): limit is RateLimit {
  if (limit?.remaining !== 0) return false;
  const resetsAt = Date.parse(limit.resetsAt);
  return Number.isFinite(resetsAt) && resetsAt > now;
}

// The clock time the budget comes back, in the viewer's locale.
export function formatResetTime(resetsAt: string): string {
  return new Date(resetsAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// "in 12 min", rounded up so it never reads "in 0 min" before the reset.
export function minutesUntil(
  resetsAt: string,
  now: number = Date.now(),
): number {
  return Math.max(1, Math.ceil((Date.parse(resetsAt) - now) / 60000));
}

// The sentence shown once per repo group and as each disabled action's
// accessible description. Static between snapshots, so it is never a
// ticking number a screen reader would repeat.
export function rateLimitReasonText(
  forgeLabel: string,
  resetsAt: string | undefined,
  now: number = Date.now(),
): string {
  const head = `${forgeLabel} API rate limit reached.`;
  if (!resetsAt || !Number.isFinite(Date.parse(resetsAt))) {
    return `${head} Actions resume once it resets.`;
  }
  return `${head} Actions resume at ${formatResetTime(resetsAt)} (in ${minutesUntil(resetsAt, now)} min).`;
}

// The header's budget text, e.g. "GH: 0/5,000 reqs, resets 14:32".
export function budgetText(shortLabel: string, limit: RateLimit): string {
  return `${shortLabel}: ${limit.remaining.toLocaleString('en-US')}/${limit.limit.toLocaleString('en-US')} reqs, resets ${formatResetTime(limit.resetsAt)}`;
}

// Milliseconds until a timer should fire to re-enable actions: just past
// the reset so the clock check above has flipped. Null when there is
// nothing to wait for.
export function msUntilReset(
  resetsAt: string,
  now: number = Date.now(),
): number | null {
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return null;
  return at - now + 250;
}
