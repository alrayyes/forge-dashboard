import type { NavCount } from './nav-counts.svelte';

// Whether a nav link is drawn (#1228). A page with nothing to show leaves the
// navigation, and a page whose count is not known yet (null) is not drawn
// either (#4276): a link appears once it is known to have something, so the
// menu grows as the counts arrive. The page you are on keeps its own link.
// Branches always shows and does not ask.
export function navLinkShown(
  count: NavCount | null,
  onItsPage: boolean,
): boolean {
  return (count !== null && count.total !== 0) || onItsPage;
}
