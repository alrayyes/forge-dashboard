// Where focus goes on closing a pull request opened from its address when its
// row is filtered out. The title box hides over one row (#3823) and a hidden
// control can't take focus, so the fallback names the first of these that is
// drawn and enabled: the Filters button, which only a phone draws (the title
// box opens its suggestion list there when it takes focus, #4360), the title
// box, the sort and group boxes (disabled over one row, #3886), the age
// filters, then Clear filters.
const CANDIDATES = [
  'filters-button',
  'title-filter',
  'pr-sort-select',
  'shared-group-select',
  'created-filter',
  'updated-filter',
  'clear-filters-button',
];

export function addressFocusFallback(isDrawn: (id: string) => boolean): string {
  return CANDIDATES.find(isDrawn) ?? CANDIDATES[CANDIDATES.length - 1];
}

// The pop-up fallback for pages whose own controls differ from the list above:
// the Filters button where one is drawn (a phone), else the title box, which
// the dialog itself skips for the first drawn control when it is hidden.
export function titleOrFiltersFallback(
  isDrawn: (id: string) => boolean,
): string {
  return isDrawn('filters-button') ? 'filters-button' : 'title-filter';
}

// Where the dialog that replaces another sends focus on close. The dialog it
// replaces already knows what opened the chain; the pill the reader clicked
// lives in a dialog that is gone by then. The pill's own id stands in only
// when no swap came before (#4351).
export function chainedReturn(current: string | null, own: string): string {
  return current || own;
}
