// Where focus goes when a dialog closes and the control that opened it is gone
// (its row is filtered out, or it never had one). Each case names its own
// candidates, in order, and focusFallback picks the first one drawn. The last
// is the answer when none is, so it is the one a page always draws.

// A pull request opened from its address, its row filtered out. The title box
// hides over one row (#3823) and a hidden control can't take focus, so this
// names the first drawn and enabled of: the Filters button, which only a phone
// draws (the title box opens its suggestion list there when it takes focus,
// #4360), the title box, the sort and group boxes (disabled over one row,
// #3886), the age filters, then Clear filters.
export const ADDRESS_CANDIDATES = [
  'filters-button',
  'title-filter',
  'pr-sort-select',
  'shared-group-select',
  'created-filter',
  'updated-filter',
  'clear-filters-button',
];

// A pop-up reached by a pill or an in-text reference, from either page: the
// Filters button on a phone, else the title box. Neither is a control a page
// can lack, so a hidden title box falls through to the first drawn control in
// the bar (#4360).
export const POPUP_CANDIDATES = ['filters-button', 'title-filter'];

export function focusFallback(
  candidates: readonly string[],
  isDrawn: (id: string) => boolean,
): string {
  return candidates.find(isDrawn) ?? candidates[candidates.length - 1];
}

// Where the dialog that replaces another sends focus on close. The dialog it
// replaces already knows what opened the chain; the pill the reader clicked
// lives in a dialog that is gone by then. The pill's own id stands in only
// when no swap came before (#4351).
export function chainedReturn(current: string | null, own: string): string {
  return current || own;
}
