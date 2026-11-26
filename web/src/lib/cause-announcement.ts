// What a page with no forge chips tells a screen reader about a forge whose
// rows are held (#5024). Only a cause a forge gains is stated, so an unchanged
// state across later reads stays quiet.

import {
  type ForgeCause,
  healthSentence,
  type StartingHealth,
} from './forge-starting.js';

// The cause each forge had at the last read.
export type CausesSeen = ReadonlyMap<string, ForgeCause>;

export type CauseAnnouncement = {
  seen: CausesSeen;
  // The live region's new text: null leaves it alone, '' empties it. Emptying
  // says nothing, and it is what lets the same sentence be heard again.
  text: string | null;
};

export function announceCauses(
  seen: CausesSeen,
  forges: readonly StartingHealth[] | undefined,
  label: (forge: string) => string,
): CauseAnnouncement {
  const next = new Map<string, ForgeCause>();
  const gained: string[] = [];
  for (const f of forges ?? []) {
    if (!f.cause) continue;
    next.set(f.forge, f.cause);
    if (seen.get(f.forge) !== f.cause)
      gained.push(healthSentence(label(f.forge), f));
  }
  const lost = [...seen.keys()].some((forge) => !next.has(forge));
  const text = gained.length > 0 ? gained.join('. ') : lost ? '' : null;
  return { seen: next, text };
}
