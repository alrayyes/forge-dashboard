// A write on a row can add or take away things above it. This works out how to
// keep the control that made the write where it was on screen, so it doesn't
// jump from under the finger.

export type Room = { above: number; below: number };

// moved is how far down the control went. The page scrolls after it; where the
// page has no scroll left in that direction, blank room is added instead.
export function planHold(
  moved: number,
  at: Room & { scrollY: number; maxScroll: number },
): Room & { scrollBy: number } {
  let { above, below } = at;
  if (moved < 0) {
    const scrolled = Math.min(-moved, at.scrollY);
    above += -moved - scrolled;
    return { scrollBy: 0 - scrolled, above, below };
  }
  const returned = Math.min(moved, above);
  above -= returned;
  const scrollBy = moved - returned;
  below += Math.max(0, scrollBy - (at.maxScroll - at.scrollY));
  return { scrollBy, above, below };
}
