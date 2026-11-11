// A box that scrolls needs a tab stop, or a keyboard user can't read past the
// first rows (axe: scrollable-region-focusable). Whether it scrolls depends on
// the viewport, the root font size and what it holds, all of which change
// while it is on screen, so the stop follows the box instead of being decided
// once when it opens.

const FOCUSABLE =
  'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

export interface ScrollRegionOptions {
  /** The accessible name a scrolling box gets. */
  label: string;
  /**
   * Leave a scrolling box alone when something inside it can already be
   * tabbed to (a link or code block): a second stop would be redundant.
   */
  skipIfFocusableDescendant?: boolean;
}

/** Make `el` a named tab stop while it overflows, and a plain box otherwise. */
export function syncScrollRegion(
  el: HTMLElement,
  { label, skipIfFocusableDescendant = false }: ScrollRegionOptions,
): () => void {
  const apply = () => {
    const scrolls =
      el.scrollHeight > el.clientHeight &&
      !(skipIfFocusableDescendant && el.querySelector(FOCUSABLE));
    if (scrolls) {
      el.tabIndex = 0;
      el.setAttribute('aria-label', label);
    } else {
      el.removeAttribute('tabindex');
      el.removeAttribute('aria-label');
    }
  };
  // The box resizes with the viewport and the root font size; its content
  // resizes with text size and what it holds. Watch the children too.
  const observer = new ResizeObserver(apply);
  observer.observe(el);
  for (const child of Array.from(el.children)) observer.observe(child);
  apply();
  return () => observer.disconnect();
}
