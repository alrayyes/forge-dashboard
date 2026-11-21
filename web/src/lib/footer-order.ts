import type { ActionName } from './allowed-actions';

// The order of the details dialog's footer (#943): the action the server
// marked primary first, the other named actions in the order given, the row's
// extras, and Close last. A cell the row did not build (null) leaves no gap.
// `primary` lists the cells that sit first, so the caller can mark them. A
// primary Close is not among them: it is last like Close always is.
export function footerOrder<T>(
  named: readonly (readonly [ActionName, T | null])[],
  primary: ActionName | undefined,
  extras: readonly T[],
  close: T | null,
): { cells: T[]; primary: T[] } {
  const first: T[] = [];
  const rest: T[] = [];
  for (const [action, cell] of named) {
    if (cell === null) continue;
    if (action === primary) first.push(cell);
    else rest.push(cell);
  }
  return {
    cells: [...first, ...rest, ...extras, ...(close === null ? [] : [close])],
    primary: first,
  };
}
