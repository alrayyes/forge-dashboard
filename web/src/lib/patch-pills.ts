// Brings a Related band's pills up to date without replacing them (#4328).
//
// The page draws a row's pills afresh whenever something about the item
// changes, and swapping the nodes drops keyboard focus, the pointer's place and
// the pill's own listeners. When the new draw lists the same pills in the same
// order, only the pills that read differently need writing: the element stays,
// and so does everything held on it. The fold's toggle is left as the reader
// set it.

import { foldedExtras } from './related-band.js';

// A pill is told apart by where it goes: a link by its address, a button by
// its id. A pill with neither can't be matched, so the band is replaced.
const keyOf = (pill: HTMLElement) => pill.getAttribute('href') ?? pill.id;

// Every pill of the band, in reading order, including the ones the fold keeps
// out of the page: they are written too, so they are right when it opens.
function pillsOf(band: HTMLElement): HTMLElement[] {
  const all = new Set<HTMLElement>(
    band.querySelectorAll<HTMLElement>('.linked-pr'),
  );
  // A Refs pill sits in a tip's host; the pill is what gets matched.
  for (const toggle of band.querySelectorAll<HTMLElement>('.related-toggle'))
    for (const hidden of foldedExtras.get(toggle) ?? [])
      all.add(hidden.querySelector<HTMLElement>('.linked-pr') ?? hidden);
  return [...all];
}

// Left as the old pill has it: a Refs pill is described by a tip beside it,
// and each draw mints a new tip id the patched pill has no tip to match.
const KEPT = 'aria-describedby';

// Makes `old` read as `fresh` where it differs, keeping the element itself.
function write(old: HTMLElement, fresh: HTMLElement) {
  if (old.outerHTML === fresh.outerHTML) return;
  for (const name of old.getAttributeNames())
    if (name !== KEPT && !fresh.hasAttribute(name)) old.removeAttribute(name);
  for (const name of fresh.getAttributeNames()) {
    if (name === KEPT) continue;
    const value = fresh.getAttribute(name) as string;
    if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  }
  if (old.innerHTML !== fresh.innerHTML)
    old.replaceChildren(...fresh.childNodes);
}

/**
 * Writes what `next` says into `current`'s pills and returns true, or returns
 * false and writes nothing when the two don't list the same pills in the same
 * order, so the caller replaces the band.
 */
export function patchPills(current: HTMLElement, next: HTMLElement): boolean {
  const old = pillsOf(current);
  const fresh = pillsOf(next);
  if (old.length !== fresh.length) return false;
  if (old.some((pill, i) => !keyOf(pill) || keyOf(pill) !== keyOf(fresh[i])))
    return false;
  old.forEach((pill, i) => {
    write(pill, fresh[i]);
  });
  return true;
}
