// Who holds an armed auto-merge, read from the forge's capabilities and never
// from its name, so a third forge needs no edit where a page arms, cancels or
// words an armed merge. The Go side is dashboard.AppMergesArmed.

import { forgeCan } from './forges';

// This app, not the forge, performs the merge once checks pass.
export function appHoldsAutoMerge(forge: string | undefined): boolean {
  return forgeCan(forge, 'autoMergeHeldByApp');
}

// A merge the forge itself scheduled on a forge where the app otherwise does
// the merging: Cancel removes that one, not this app's own intent.
export function forgeHoldsArmed(item: {
  forge: string;
  autoMergeHeldBy?: string;
}): boolean {
  return appHoldsAutoMerge(item.forge) && item.autoMergeHeldBy === 'forge';
}
