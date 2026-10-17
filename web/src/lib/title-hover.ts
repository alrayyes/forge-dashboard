// A title cut with an ellipsis carries its whole text as hover text, and only
// while it is cut. One ResizeObserver serves every row: it reports a size
// change for each tracked title, so a layout change or a resize re-checks
// them together, reading every width before writing any attribute.
// https://github.com/alrayyes/forge-dashboard/issues/1695

type Measured = Pick<HTMLElement, 'scrollWidth' | 'clientWidth'>;

/** True when the text is wider than the box that clips it. */
export function isTruncated(el: Measured): boolean {
  return el.scrollWidth > el.clientWidth;
}

export interface TitleHover {
  /** Watch a title span; `title` is its text as written on the forge. */
  track(el: HTMLElement, title: string): void;
  /** Measure every tracked title again (a web font changes text widths). */
  recheck(): void;
  /** Stop watching spans that have left the page. */
  prune(): void;
  destroy(): void;
}

export function createTitleHover(
  Observer: typeof ResizeObserver = ResizeObserver,
): TitleHover {
  const titles = new Map<HTMLElement, string>();
  // Read every width first, then write: no forced layout between rows.
  const apply = (els: Iterable<HTMLElement>) => {
    const cut = [...els].map((el) => [el, isTruncated(el)] as const);
    for (const [el, truncated] of cut) {
      const title = titles.get(el);
      if (title === undefined) continue;
      if (truncated) el.setAttribute('title', title);
      else el.removeAttribute('title');
    }
  };
  const observer = new Observer((entries) =>
    apply(entries.map((entry) => entry.target as HTMLElement)),
  );
  // Text widths change when a web font arrives, with no box resizing to say so.
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  const recheck = () => apply(titles.keys());
  fonts?.addEventListener?.('loadingdone', recheck);
  void fonts?.ready?.then(recheck);
  return {
    track(el, title) {
      titles.set(el, title);
      // Observing reports the first size too, so this also does the first check.
      observer.observe(el);
    },
    recheck,
    prune() {
      for (const el of titles.keys()) {
        if (el.isConnected) continue;
        observer.unobserve(el);
        titles.delete(el);
      }
    },
    destroy() {
      fonts?.removeEventListener?.('loadingdone', recheck);
      observer.disconnect();
      titles.clear();
    },
  };
}
