// Where focus goes on closing a pull request opened from its address when its
// row is filtered out. The title box hides over one row (#3823) and a hidden
// control can't take focus, so the fallback names the first of these that is
// drawn: the title box, the Filters button a phone keeps in the bar, then the
// sort box every bar draws.
const CANDIDATES = ['title-filter', 'filters-button', 'pr-sort-select'];

export function addressFocusFallback(isDrawn: (id: string) => boolean): string {
  return CANDIDATES.find(isDrawn) ?? CANDIDATES[CANDIDATES.length - 1];
}
