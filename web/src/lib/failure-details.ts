// What Copy holds for a failed action (#1323). Kept apart from action-error so
// it needs nothing but types, and a unit test can load it on its own.

import type { FailureDetails } from './feedback';

// A failed request, as far as Copy needs it: the status when an answer came,
// the body as it arrived, or the browser's own message when nothing did.
export type FailedRequest = Error & { status?: number; raw?: unknown };

// The most of a non-JSON body that is kept (a proxy's error page, say). The
// finished failures are stored in sessionStorage with it, and one write over
// its quota would lose the whole list.
export const MAX_RAW_TEXT = 4000;

function capped(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length <= MAX_RAW_TEXT) return raw;
  return `${raw.slice(0, MAX_RAW_TEXT)}… (${raw.length - MAX_RAW_TEXT} more characters not kept)`;
}

// What Copy holds for a failure (#1323): the status and the body as received,
// or the browser's own error when nothing came back, with the action's
// context and when it happened.
export function failureDetails(
  err: FailedRequest,
  context: { action: string; forge: string; repo: string; number: number },
  now: Date = new Date(),
): FailureDetails {
  const base = { ...context, at: now.toISOString() };
  if (err.status === undefined)
    return { status: null, networkError: err.message, ...base };
  return { status: err.status, response: capped(err.raw) ?? null, ...base };
}
