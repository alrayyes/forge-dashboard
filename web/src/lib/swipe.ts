// Swipe to dismiss a toast (#4020). The drag is an extra way in: the close
// button stays, which is what WCAG 2.5.7 asks of a dragging movement.

// How far a drag must travel, as a share of the toast's width, to count.
export const SWIPE_DISMISS_FRACTION = 1 / 3;

export function swipeDismisses(dx: number, width: number): boolean {
  return width > 0 && Math.abs(dx) > width * SWIPE_DISMISS_FRACTION;
}
