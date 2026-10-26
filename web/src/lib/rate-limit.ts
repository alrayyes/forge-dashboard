// A rate limit is a "wait until" condition, not a transient fault: the
// forge says when the budget comes back, so a blocked action shows that
// time and re-enables itself instead of offering a Retry that can't work
// (#732). Pure helpers, no DOM, so the dashboard page stays the only place
// that touches elements.

import { formatTime } from './time.svelte';

// The budget as the server reports it: the numbers only. How worried to be
// about them is graded by rateLimitSeverity below (#2929).
export type RateLimit = {
  limit: number;
  remaining: number;
  resetsAt: string;
};

export type RateLimitSeverity = 'ok' | 'warning' | 'low' | 'exceeded';

// Under this share of a budget left it is low, under the next it is a warning.
const LOW_FRACTION = 0.05;
const WARNING_FRACTION = 0.2;

// The one grade of a budget, used by the banner, the lock, the footer and the
// Insights gauge. Exceeded is a spent budget whose reset is still ahead (or
// has no usable time): once the reset has passed the forge has refilled it,
// so a stale reading grades low until the next snapshot says otherwise. The
// numbers are the server's; the clock is this tab's.
export function rateLimitSeverity(
  limit: RateLimit,
  now: number = Date.now(),
): RateLimitSeverity {
  if (limit.remaining === 0) {
    const resetsAt = Date.parse(limit.resetsAt);
    if (!Number.isFinite(resetsAt) || resetsAt > now) return 'exceeded';
  }
  if (limit.limit > 0) {
    const fraction = limit.remaining / limit.limit;
    if (fraction < LOW_FRACTION) return 'low';
    if (fraction < WARNING_FRACTION) return 'warning';
  }
  return 'ok';
}

export const PERMISSION_REASON =
  'Missing permission — check your token in Settings.';

// True when the banner should say the budget is running low: graded low with
// something still left. A spent budget past its reset grades low too, but it
// is a stale reading the next snapshot replaces, not a budget running low.
export function isRunningLow(
  limit: RateLimit,
  now: number = Date.now(),
): boolean {
  return limit.remaining > 0 && rateLimitSeverity(limit, now) === 'low';
}

// True while the budget grades exceeded and the reset is still ahead. The
// reset is checked against the clock, not stored, so a stale snapshot can't
// keep an action locked past the reset time (#979).
export function isRateLimited(
  limit: RateLimit | undefined,
  now: number = Date.now(),
): limit is RateLimit {
  if (!limit || rateLimitSeverity(limit, now) !== 'exceeded') return false;
  const resetsAt = Date.parse(limit.resetsAt);
  return Number.isFinite(resetsAt) && resetsAt > now;
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
  return `${head} Actions resume at ${formatTime(resetsAt)} (in ${minutesUntil(resetsAt, now)} min).`;
}

// The header's budget text, e.g. "GH REST: 0/5,000 reqs, resets 14:32". The
// label says which budget it is, since GitHub keeps two (#1433). A count
// above its limit means the limit isn't this budget's, so it says what is
// left and doesn't print a ratio that can't be true.
export function budgetText(label: string, limit: RateLimit): string {
  const remaining = limit.remaining.toLocaleString('en-US');
  const resets = `resets ${formatTime(limit.resetsAt)}`;
  if (limit.remaining > limit.limit)
    return `${label}: ${remaining} reqs left, ${resets}`;
  return `${label}: ${remaining}/${limit.limit.toLocaleString('en-US')} reqs, ${resets}`;
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
