// What a row may claim while its forge can't be asked: one rule for every pill
// and action. It reads the forge's lock (built from its health) and never a
// forge's name, so a row from any forge gets the same words (#3968).
// The Go mirror is internal/dashboard/row_claim.go.

import { isReadOnlyLock, type LockInfo } from './lock-info';

const WHY =
  "The forge says this can't merge, and says the same while it is still checking. No merge or update has been refused with a conflict yet.";

// conflict: a conflict flag. state: any other fact the forge reports (behind,
// checks, merge status, auto-merge). action: whether a control may be drawn.
export type ClaimKind = 'conflict' | 'state' | 'action';

// confirmed: the forge answered. carried_over: the row is an earlier answer
// because the forge can't be asked. unknown: the forge answered but has not
// said (an unconfirmed conflict).
export type ClaimState = 'confirmed' | 'carried_over' | 'unknown';

export type RowClaimInput = {
  kind: ClaimKind;
  // The forge's lock on its controls from the board's health, or null.
  lock: LockInfo | null;
  // How long ago the rows were read, already formatted, when known.
  since?: string;
  // False when the forge has not said (a conflict only its flag reports).
  answered?: boolean;
  // The row offers an Update branch that is open to press.
  updateOffered?: boolean;
};

export type RowClaim = {
  state: ClaimState;
  // A control may be drawn and pressed: the forge can be asked and its budget
  // is not spent.
  actionsOpen: boolean;
  // Why the claim is not confirmed; empty when it is.
  reason: string;
};

function carriedOver(lock: LockInfo | null): boolean {
  return lock?.code === 'forge_unreachable' || lock?.code === 'forge_starting';
}

export function rowClaim({
  kind,
  lock,
  since,
  answered = true,
  updateOffered = false,
}: RowClaimInput): RowClaim {
  const actionsOpen = !isReadOnlyLock(lock);
  const unconfirmed = kind === 'conflict' && !answered;
  const when = since ? ` from ${since}` : '';

  if (carriedOver(lock)) {
    const earlier = `The forge isn't answering yet, so this may be an earlier answer${when}, and no action can run until it does.`;
    return {
      state: 'carried_over',
      actionsOpen,
      reason: unconfirmed
        ? `${WHY} ${earlier}`
        : `Showing data${when}. ${earlier}`,
    };
  }
  if (!unconfirmed) return { state: 'confirmed', actionsOpen, reason: '' };

  let next: string;
  if (lock?.code === 'rate_limited')
    next = `${lock.reason} No action can run until then.`;
  else if (updateOffered) next = 'Use Update branch to find out.';
  else
    next =
      'Wait for the forge to finish checking, or open the pull request on the forge.';
  return { state: 'unknown', actionsOpen, reason: `${WHY} ${next}` };
}
