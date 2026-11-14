// The count on a list page's board header: "4 open", or "Showing 2 of 4" when a
// filter narrows the list (#1325). The number a person scans for is set apart,
// so CSS can weigh it as a result total (#3867). Joined, the parts read exactly
// as the one line always did.
export type ShownCountParts = {
  before: string;
  number: string;
  after: string;
};

export function shownCountParts(shown: number, total: number): ShownCountParts {
  return shown === total
    ? { before: '', number: String(total), after: ' open' }
    : { before: 'Showing ', number: String(shown), after: ` of ${total}` };
}

// Draws the parts into the count element. It is not a live region: a filter
// change already announces its result count through the status region.
export function renderShownCount(
  el: HTMLElement,
  shown: number,
  total: number,
): void {
  const { before, number, after } = shownCountParts(shown, total);
  const strong = el.ownerDocument.createElement('strong');
  strong.textContent = number;
  el.replaceChildren(before, strong, after);
}
