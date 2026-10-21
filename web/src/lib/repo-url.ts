// The address of the repository an item belongs to, from the item's own
// address. Both forges end an item's address in `/<kind>/<number>`: GitHub
// uses `pull` and `issues`, Forgejo `pulls` and `issues`. The server hands the
// page the item's address and owns the forge's URL scheme; this only strips
// the tail it already knows the shape of, so a reference such as `#12` can be
// linked against the same repository.
const ITEM_TAIL = /\/(?:pulls?|issues)\/\d+\/?$/;

export function repoUrlOf(itemUrl: string): string | null {
  if (!/^https?:\/\//i.test(itemUrl)) return null;
  return ITEM_TAIL.test(itemUrl) ? itemUrl.replace(ITEM_TAIL, '') : null;
}
