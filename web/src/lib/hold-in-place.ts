// A write on a row can add or take away things above it. This works out how to
// keep the control that made the write where it was on screen, so it doesn't
// jump from under the finger.

export type Room = { above: number; below: number };

// The page as it is just after the write. height is everything in it, room
// included, which is less than the viewport on a short page.
type Page = Room & { scrollY: number; viewport: number; height: number };

// moved is how far down the control went. The page scrolls after it. Scrolling
// up past the top takes blank room above instead, and scrolling down past the
// end takes only as much blank room below as the new position needs.
export function planHold(moved: number, at: Page): Room & { scrollTo: number } {
  let { above } = at;
  let scrollTo: number;
  if (moved < 0) {
    const scrolled = Math.min(-moved, at.scrollY);
    above += -moved - scrolled;
    scrollTo = at.scrollY - scrolled;
  } else {
    const returned = Math.min(moved, above);
    above -= returned;
    scrollTo = at.scrollY + moved - returned;
  }
  const content = at.height - at.above - at.below;
  const below =
    scrollTo > 0 ? Math.max(0, scrollTo + at.viewport - content - above) : 0;
  return { scrollTo, above, below };
}
