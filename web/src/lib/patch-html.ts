// Keeps rendered Markdown in place when a fresh read changes only part of it
// (#4194). Replacing the whole of a description would drop the node the
// browser anchors the scroll position to, and the reader's selection with it.
// Blocks that match at the start and the end stay as they are; only the part
// between is swapped.

// How many entries the two lists share at the front, and then at the back of
// what is left, so the two never overlap.
export function commonEnds(
  before: string[],
  after: string[],
): { head: number; tail: number } {
  const most = Math.min(before.length, after.length);
  let head = 0;
  while (head < most && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < most - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return { head, tail };
}

const keyOf = (n: Node): string =>
  n instanceof Element ? n.outerHTML : `#${n.textContent}`;

// A Svelte action. `markup` is only ever renderMarkdown() output.
//
// Blocks are compared with the markup that drew them, not with the live DOM:
// imageFallback and the expand controls change a block after it is drawn, and
// a block compared by its live HTML would never match again.
export function patchHtml(node: HTMLElement, markup: string) {
  let keys: string[] = [];
  let nodes: ChildNode[] = [];

  const parse = (next: string) => {
    const template = document.createElement('template');
    template.innerHTML = next;
    return [...template.content.childNodes];
  };
  const replaceAll = (fresh: ChildNode[]) => {
    node.replaceChildren(...fresh);
    keys = fresh.map(keyOf);
    nodes = [...node.childNodes];
  };

  const set = (next: string) => {
    const fresh = parse(next);
    const freshKeys = fresh.map(keyOf);
    // Something other than this action took a block out: start again.
    if (nodes.some((n) => n.parentNode !== node)) {
      replaceAll(fresh);
      return;
    }
    const { head, tail } = commonEnds(keys, freshKeys);
    if (head === keys.length && head === freshKeys.length) return;
    for (const n of nodes.slice(head, nodes.length - tail)) n.remove();
    const anchor = tail > 0 ? nodes[nodes.length - tail] : null;
    const added = fresh.slice(head, fresh.length - tail);
    for (const n of added) node.insertBefore(n, anchor);
    nodes = [
      ...nodes.slice(0, head),
      ...added,
      ...nodes.slice(nodes.length - tail),
    ];
    keys = freshKeys;
  };
  replaceAll(parse(markup));
  return { update: set };
}
