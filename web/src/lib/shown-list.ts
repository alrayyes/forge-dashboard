import type { FilterableItem } from './filters';

// The list a page is showing, and whether one has landed yet, so an empty
// list on screen is empty and not just not here yet. The flag can only be
// set by landing a list, so a new settle path cannot forget it.
export function shownList<T>() {
  let items: T[] = [];
  let landed = false;
  return {
    get items(): T[] {
      return items;
    },
    get landed(): boolean {
      return landed;
    },
    land(next: T[]): void {
      items = next;
      landed = true;
    },
  };
}

export type ShownList<T> = ReturnType<typeof shownList<T>>;

// One JSON array per row, so a separator inside a title cannot make two
// different sets read the same.
function key(items: FilterableItem[], row: (i: FilterableItem) => unknown[]) {
  return JSON.stringify(
    items.map((i) => JSON.stringify(row(i))).sort((x, y) => x.localeCompare(y)),
  );
}

// How two lists differ in what the Repo, Author, Label, age and Title choices
// read. 'titles' means only the Title suggestions changed; 'none' means a
// poll changed nothing the dropdowns read.
export function choicesChange(
  a: FilterableItem[],
  b: FilterableItem[],
): 'none' | 'titles' | 'all' {
  const rest = (i: FilterableItem) => [
    i.forge,
    i.repo,
    i.author,
    i.createdAt,
    i.updatedAt,
    (i.labels || []).map((l) => l.name),
  ];
  if (key(a, rest) !== key(b, rest)) return 'all';
  const title = (i: FilterableItem) => [i.title];
  return key(a, title) !== key(b, title) ? 'titles' : 'none';
}
