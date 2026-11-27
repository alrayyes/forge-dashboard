// On the one-line list an armed row's chip ends against Cancel, on the CI
// pill's line (#4971). Where it would lie over the CI pill or a flags pill, the
// chip and Cancel make a second line. Only the browser knows how wide the three
// are, so this measures them; CSS acts on the class.

const GAP = 4; // the cell's column gap
const WRAPS = 'status-cell-armed-wrap';

export function fitArmedChips(list: HTMLElement): void {
  // All the reads, then all the writes: one layout for the whole list. A chip's
  // place across the row is the same on either line, so nothing has to be reset
  // before measuring and the answer can't flip back and forth.
  const answers = Array.from(
    list.querySelectorAll<HTMLElement>('.status-cell-armed'),
    (cell) => ({ cell, wraps: wraps(cell) }),
  );
  for (const answer of answers)
    answer.cell.classList.toggle(WRAPS, answer.wraps);
}

function wraps(cell: HTMLElement): boolean {
  const chip = cell.querySelector(':scope > .wait-slot > .wait-chip');
  if (!chip) return false;
  const { left, width } = chip.getBoundingClientRect();
  if (width === 0) return false;
  // The flags slot is as wide as its track, so its pills are what count.
  const pills = cell.querySelectorAll('.ci-pill, .status-flags > *');
  return Array.from(pills).some((pill) => {
    const box = pill.getBoundingClientRect();
    return box.width > 0 && left < box.right + GAP - 0.5;
  });
}

// Fits the chips again whenever the rows change (a render, a live CI pill) or
// the list does (the window, the text size), once per frame.
export function watchArmedChips(list: HTMLElement): void {
  let frame = 0;
  const later = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      fitArmedChips(list);
    });
  };
  new MutationObserver(later).observe(list, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  if (typeof ResizeObserver !== 'undefined')
    new ResizeObserver(later).observe(list);
  void document.fonts?.ready.then(later);
  later();
}
