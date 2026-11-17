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
export function patchHtml(node: HTMLElement, markup: string) {
  const set = (next: string) => {
    if (node.childNodes.length === 0) {
      node.innerHTML = next;
      return;
    }
    const template = document.createElement('template');
    template.innerHTML = next;
    const old = [...node.childNodes];
    const fresh = [...template.content.childNodes];
    const { head, tail } = commonEnds(old.map(keyOf), fresh.map(keyOf));
    if (head === old.length && head === fresh.length) return;
    for (const n of old.slice(head, old.length - tail)) n.remove();
    const anchor = tail > 0 ? old[old.length - tail] : null;
    for (const n of fresh.slice(head, fresh.length - tail)) {
      node.insertBefore(n, anchor);
    }
  };
  set(markup);
  return {
    update: set,
  };
}
