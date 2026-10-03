// The structured answer a refused pull request action carries
// (components.schemas.ActionError). The server decides why an action was
// refused by re-reading the pull request; this file only turns that answer
// into what the row, the toast and the row's state show. Every pull request
// action (Merge, Close, Update branch, Enable auto-merge, the Dependabot and
// Renovate rebases) renders its failures through here.

import type { ActionRef, FeedbackStore } from './feedback';
import { PERMISSION_REASON } from './rate-limit';

export type ActionCode =
  | 'already_merged'
  | 'already_closed'
  | 'not_mergeable'
  | 'conflict'
  | 'behind'
  | 'checks_pending'
  | 'checks_failing'
  | 'blocked_by_protection'
  | 'already_up_to_date'
  | 'auto_merge_not_allowed'
  | 'ready_to_merge'
  | 'label_missing'
  | 'permission'
  | 'rate_limited'
  | 'unknown';

export type ActionFailure = {
  status?: number;
  code: ActionCode;
  message: string;
  resetsAt?: string;
};

// A failed request, carrying the server's answer when there was one. A
// request that never got a response has no status and no code: that is the
// ambiguous-outcome case (#447), which callers handle separately.
export type ActionRequestError = Error & { status?: number; code?: ActionCode };

export type SettledState = 'merged' | 'closed';

export type ActionOutcome =
  // The pull request has nothing left to do: it is already merged or closed.
  | { kind: 'settled'; state: SettledState; message: string }
  // A refusal that waiting won't fix and clicking again won't help.
  | { kind: 'locked'; code: ActionCode; reason: string }
  // Anything else: show the reason, leave the action clickable.
  | { kind: 'failed'; reason: string };

const CODES: ReadonlySet<string> = new Set<ActionCode>([
  'already_merged',
  'already_closed',
  'not_mergeable',
  'conflict',
  'behind',
  'checks_pending',
  'checks_failing',
  'blocked_by_protection',
  'already_up_to_date',
  'auto_merge_not_allowed',
  'ready_to_merge',
  'label_missing',
  'permission',
  'rate_limited',
  'unknown',
]);

export const NO_REASON = 'The forge refused this action and gave no reason.';
export const FORGE_UNAVAILABLE =
  "The forge didn't answer. Try again in a moment.";

// What the row and the toast may say for a failure. Only the server's own
// `message` qualifies, and only if it reads as a sentence: the raw `error`
// string (internal prefixes, API paths, a swagger URL, JSON) stays in the
// server log. Anything else becomes one fallback sentence (#752).
function plainReason(
  body: Record<string, unknown> | null,
  status: number,
): string {
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (message && !looksRaw(message)) return message;
  return status === 502 || status === 503 || status === 504
    ? FORGE_UNAVAILABLE
    : NO_REASON;
}

function looksRaw(text: string): boolean {
  return /^dashboard:|\b(forgejo|github): |\/(api|repos)\/|https?:\/\/|^\s*[{[]/i.test(
    text,
  );
}

// Reads a non-2xx response into an error carrying the server's code. A body
// with no code (an old backend, a proxy's error page) reads as 'unknown'
// with whatever text it had, so a row never says only "failed".
export async function readActionFailure(
  res: Response,
): Promise<ActionRequestError> {
  let body: Record<string, unknown> | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const code = (
    typeof body?.code === 'string' && CODES.has(body.code)
      ? body.code
      : 'unknown'
  ) as ActionCode;
  const text = plainReason(body, res.status);
  const err: ActionRequestError = new Error(text);
  err.status = res.status;
  err.code = code;
  (err as Error & { resetsAt?: string }).resetsAt =
    typeof body?.resetsAt === 'string' ? body.resetsAt : undefined;
  return err;
}

// What a refusal means for the row. rateLimitedReason builds the sentence
// for a rate limit: it gets the server's resetsAt when there was one, and
// can fall back to the budget the last snapshot showed when there wasn't.
//
// retryable names the codes an action treats as passing by themselves, so
// the row keeps its button and offers Retry instead of locking. Rate limit
// and permission never are: they lock, with no Retry (#732, #734).
export function interpretActionFailure(
  err: ActionRequestError,
  rateLimitedReason: (resetsAt: string | undefined) => string,
  retryable: ReadonlySet<ActionCode> = new Set(),
): ActionOutcome {
  const code = err.code ?? 'unknown';
  if (retryable.has(code) && code !== 'permission' && code !== 'rate_limited')
    return { kind: 'failed', reason: err.message };
  switch (code) {
    case 'already_merged':
      return { kind: 'settled', state: 'merged', message: 'Already merged.' };
    case 'already_closed':
      return { kind: 'settled', state: 'closed', message: 'Already closed.' };
    case 'permission':
      return { kind: 'locked', code, reason: PERMISSION_REASON };
    case 'rate_limited':
      return {
        kind: 'locked',
        code,
        reason: rateLimitedReason(
          (err as Error & { resetsAt?: string }).resetsAt,
        ),
      };
    case 'unknown':
      return { kind: 'failed', reason: err.message };
    default:
      return { kind: 'locked', code, reason: err.message };
  }
}

export const SETTLED_LABELS: Record<SettledState, string> = {
  merged: 'Merged',
  closed: 'Closed',
};

// The row's replacement for the action button once the pull request is
// found merged or closed. Plain text, not a button: there is nothing left
// to click, and it is gone on the next snapshot.
export function settledBadge(state: SettledState): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'row-settled';
  badge.dataset.state = state;
  badge.textContent = SETTLED_LABELS[state];
  return badge;
}

// Shows a settled outcome: finishes the action's feedback entry with a
// polite toast, and clears the row's earlier failure lines, which described
// a state that no longer matters.
export function showSettled(
  store: FeedbackStore,
  actionKey: string,
  ref: ActionRef,
  outcome: Extract<ActionOutcome, { kind: 'settled' }>,
) {
  store.dropFailedFor(ref.key, actionKey);
  store.update(actionKey, {
    phase: 'done',
    inline: outcome.message,
    message: `${outcome.message} Nothing left to do.`,
    toast: true,
    announce: `${outcome.message} Nothing left to do.`,
  });
}
