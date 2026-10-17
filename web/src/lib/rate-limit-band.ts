// Display text for how much of a rate limit budget is left. A separate
// module so it loads without the Svelte runtime in unit tests.

import type { RateLimit } from './rate-limit';

// Ceilings for the share of a budget left, smallest first. Display only: the
// server decides when a budget is low, so these never grade anything. They are
// all true of any budget they are picked for, whatever the server's cutoff is.
const BAND_CEILINGS = [1, 2, 5, 10, 25, 50, 100];

// The share left as a coarse "under N%", steady while the count falls inside
// one band, so a screen reader can be told once per band instead of on every
// poll (WCAG 4.1.3). Null when the numbers don't describe a share.
export function remainingBand(limit: RateLimit): string | null {
  if (
    !(limit.limit > 0) ||
    limit.remaining < 0 ||
    limit.remaining > limit.limit
  )
    return null;
  const percent = (limit.remaining / limit.limit) * 100;
  const ceiling = BAND_CEILINGS.find((c) => percent < c);
  return ceiling === undefined ? null : `under ${ceiling}%`;
}
