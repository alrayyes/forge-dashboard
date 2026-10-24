// Whether a row's action entry is a two-step interaction a moved row could
// break, so a snapshot must not reorder the board under it.

export type RowActionEntry = {
  phase: string;
  queued?: { restored?: boolean };
};

// Phases that are not a click of this page's own mid-way: nothing to protect.
// "locked" already swaps the button for a single-click Retry, "rebasing" is a
// bot acting on its own, and "cancelled" is a cancel the forge took that only
// a stale snapshot still lists.
const NOT_IN_FLIGHT = new Set([
  'idle',
  'locked',
  'merged',
  'closed',
  'rebasing',
  'cancelled',
]);

export function holdsTheBoard(entry: RowActionEntry): boolean {
  return !entry.queued?.restored && !NOT_IN_FLIGHT.has(entry.phase);
}
