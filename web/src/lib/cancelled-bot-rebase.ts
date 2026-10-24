// A Renovate rebase the forge has just cancelled stays "cancelled" on this
// page until a snapshot stops listing the cancel, so a refresh that failed
// can't redraw an idle Cancel button from the snapshot it replaced. A box
// ticked again later is listed by a newer snapshot, which starts clean.

export type CancelEntry = { phase: string };

// Forgets each cancelled entry whose pull request no longer lists the cancel.
export function settleCancelled(
  states: Record<string, CancelEntry>,
  listsCancel: (prKey: string) => boolean,
): void {
  for (const key of Object.keys(states)) {
    if (states[key].phase === 'cancelled' && !listsCancel(key))
      delete states[key];
  }
}
