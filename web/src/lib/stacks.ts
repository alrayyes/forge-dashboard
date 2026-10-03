// Showing stacked pull requests together (#861). The server says where each
// one sits (`stack`, `stackedOn`); this only decides how the list lays them
// out. A stack is its members in position order, placed where the first of
// them appears in the list, so it lands where its most recently updated
// member would sort.

export type StackItem = {
  forge: string;
  repo: string;
  number: number;
  stack?: { position: number; size: number } | null;
  stackedOn?: { number: number } | null;
};

export type StackMember<T> = { item: T; matched: boolean };

export type Entry<T> =
  | { kind: 'single'; item: T }
  | { kind: 'stack'; members: StackMember<T>[] };

const keyOf = (item: StackItem) => `${item.forge}:${item.repo}#${item.number}`;

// The bottom of the stack a pull request is in, found by following
// `stackedOn` through the snapshot, or null when it is in none. A loop is
// cut off rather than followed forever.
function rootKey<T extends StackItem>(
  item: T,
  byKey: Map<string, T>,
): string | null {
  if (!item.stack) return null;
  let current = item;
  for (let hops = 0; hops < 64; hops++) {
    const parent = current.stackedOn;
    if (!parent) return keyOf(current);
    const next = byKey.get(`${current.forge}:${current.repo}#${parent.number}`);
    if (!next) return keyOf(current);
    current = next;
  }
  return keyOf(current);
}

function byPosition<T extends StackItem>(a: T, b: T): number {
  return (
    (a.stack?.position ?? 0) - (b.stack?.position ?? 0) || a.number - b.number
  );
}

// Lays out the pull requests that matched the filters. A stack that has any
// matching member is kept whole, and the members that didn't match are
// flagged so the page can dim them.
export function arrange<T extends StackItem>(
  matched: T[],
  all: T[],
): Entry<T>[] {
  const byKey = new Map(all.map((item) => [keyOf(item), item]));
  const matchedKeys = new Set(matched.map(keyOf));
  const stacks = new Map<string, T[]>();
  for (const item of all) {
    const root = rootKey(item, byKey);
    if (root === null) continue;
    const members = stacks.get(root);
    if (members) members.push(item);
    else stacks.set(root, [item]);
  }

  const out: Entry<T>[] = [];
  const emitted = new Set<string>();
  for (const item of matched) {
    const root = rootKey(item, byKey);
    if (root === null) {
      out.push({ kind: 'single', item });
      continue;
    }
    if (emitted.has(root)) continue;
    emitted.add(root);
    const members = (stacks.get(root) ?? [item]).slice().sort(byPosition);
    out.push({
      kind: 'stack',
      members: members.map((m) => ({
        item: m,
        matched: matchedKeys.has(keyOf(m)),
      })),
    });
  }
  return out;
}

export function entryRows<T>(entry: Entry<T>): number {
  return entry.kind === 'single' ? 1 : entry.members.length;
}

// Splits entries into pages of about `pageSize` rows without splitting a
// stack: a stack starts on the page it would have started on, and one bigger
// than a page gets a page of its own.
export function pagesOf<T>(
  entries: Entry<T>[],
  pageSize: number,
): Entry<T>[][] {
  const pages: Entry<T>[][] = [];
  let current: Entry<T>[] = [];
  let rows = 0;
  for (const entry of entries) {
    const size = entryRows(entry);
    if (rows > 0 && rows + size > pageSize) {
      pages.push(current);
      current = [];
      rows = 0;
    }
    current.push(entry);
    rows += size;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

// Every open pull request in the same stack as `item`, bottom first.
export function stackMembers<T extends StackItem>(item: T, all: T[]): T[] {
  const byKey = new Map(all.map((i) => [keyOf(i), i]));
  const root = rootKey(item, byKey);
  if (root === null) return [item];
  return all.filter((i) => rootKey(i, byKey) === root).sort(byPosition);
}
