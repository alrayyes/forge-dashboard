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

// What the Dashboard does with a settled list: nothing, rebuild only the Title
// suggestions, or rebuild every choice. A Title box with focus keeps its
// suggestions as they are, and a title filter makes the other choices depend
// on titles, so those need the full rebuild.
export function offerAction(
  change: 'none' | 'titles' | 'all',
  titleFilterSet: boolean,
  titleFocused: boolean,
): 'skip' | 'suggest' | 'rebuild' {
  if (change === 'none') return 'skip';
  if (change === 'titles' && !titleFilterSet)
    return titleFocused ? 'skip' : 'suggest';
  return 'rebuild';
}

// Each row is one JSON array, so a separator inside a title cannot make two
// different sets read the same. Sorted by code unit: cheap, and a total order,
// so canonically equivalent strings cannot tie and swap places.
const byCodeUnit = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

function sortedRows(rows: unknown[][]): string {
  return JSON.stringify(rows.map((r) => JSON.stringify(r)).sort(byCodeUnit));
}

// How two lists differ in what the Repo, Author, Label, age and Title choices
// read. 'titles' means only the Title suggestions changed; 'none' means a
// poll changed nothing the dropdowns read.
export function choicesChange(
  a: FilterableItem[],
  b: FilterableItem[],
): 'none' | 'titles' | 'all' {
  const read = (items: FilterableItem[]) => {
    const rest: unknown[][] = [];
    const titles: unknown[][] = [];
    for (const i of items) {
      rest.push([
        i.forge,
        i.repo,
        i.author,
        i.createdAt,
        i.updatedAt,
        (i.labels || []).map((l) => l.name),
      ]);
      titles.push([i.title]);
    }
    return { rest: sortedRows(rest), titles: sortedRows(titles) };
  };
  const x = read(a);
  const y = read(b);
  if (x.rest !== y.rest) return 'all';
  return x.titles !== y.titles ? 'titles' : 'none';
}
