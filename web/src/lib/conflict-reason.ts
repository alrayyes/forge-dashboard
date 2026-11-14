// What a row says when the forge's merge flag stayed false and no refusal named
// a conflict ("Conflict not confirmed", #3308). One place, with no forge in it:
// it reads what the row offers and whether the forge's controls are locked, so
// a row from any forge gets the same words (#3965).

import { isReadOnlyLock, type LockInfo } from './lock-info';

const WHY =
  "The forge says this can't merge, and says the same while it is still checking. No merge or update has been refused with a conflict yet.";

export type ConflictReasonInput = {
  // The forge's lock on its controls from the board's health, or null.
  lock: LockInfo | null;
  // The row offers an Update branch that is open to press.
  updateOffered: boolean;
};

// Names only what the row can do. While the forge is read-only no control is
// drawn, so the reason says why instead of pointing at one.
export function unconfirmedConflictReason({
  lock,
  updateOffered,
}: ConflictReasonInput): string {
  if (isReadOnlyLock(lock)) {
    if (lock?.code === 'rate_limited')
      return `${WHY} ${lock.reason} No action can run until then.`;
    return `${WHY} The forge can't be reached, so this is its earlier answer and no action can run until it answers again. The banner says how old the data is.`;
  }
  if (updateOffered) return `${WHY} Use Update branch to find out.`;
  return `${WHY} Wait for the forge to finish checking, or open the pull request on the forge.`;
}
