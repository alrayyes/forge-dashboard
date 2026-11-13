// A Svelte action for a rendered Markdown container (#3405). The server can
// refuse or fail an embedded image (a private repository the token can't read,
// a file that isn't an image, a forge that is down). The browser would then
// draw a broken-image icon; this swaps in a line of text instead.
// `error` doesn't bubble, so the listener sits on the capture phase.
export function imageFallback(node: HTMLElement): { destroy(): void } {
  const onError = (event: Event) => {
    const img = event.target;
    if (
      !(img instanceof HTMLImageElement) ||
      !img.classList.contains('md-image')
    ) {
      return;
    }
    const note = document.createElement('span');
    note.className = 'md-image-missing';
    note.textContent = img.alt
      ? `Image not available: ${img.alt}`
      : 'Image not available';
    const link = img.parentElement;
    // Drop the link around it too: it points at the same image.
    (link instanceof HTMLAnchorElement && link.childNodes.length === 1
      ? link
      : img
    ).replaceWith(note);
  };
  // A loaded image drops its skeleton (#3468). `load` doesn't bubble either.
  const onLoad = (event: Event) => {
    if (
      event.target instanceof HTMLImageElement &&
      event.target.classList.contains('md-image')
    ) {
      event.target.classList.add('md-image-loaded');
      syncExpandControl(event.target);
    }
  };
  // An image that finished before this listener attached (a cached one) never
  // fires `load` for it, and markup can arrive later, so check what is already
  // there now and whenever nodes are added.
  const settle = () => {
    for (const img of node.querySelectorAll<HTMLImageElement>('img.md-image')) {
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add('md-image-loaded');
        syncExpandControl(img);
      }
    }
  };
  const observer = new MutationObserver(settle);
  observer.observe(node, { childList: true, subtree: true });
  // A turned phone or a resized window changes which images the cap bites.
  const resizer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(settle);
  resizer?.observe(node);
  node.addEventListener('error', onError, true);
  node.addEventListener('load', onLoad, true);
  settle();
  return {
    destroy: () => {
      observer.disconnect();
      resizer?.disconnect();
      node.removeEventListener('error', onError, true);
      node.removeEventListener('load', onLoad, true);
    },
  };
}

// A capped image (#3468) opens full size in the viewer, but the `zoom-in`
// cursor is the only hint and a touch screen has no cursor (#3835). Draw a
// visible "View larger" button after the image's link, only when the height
// cap really shrank it. The visible text leads the accessible name (WCAG
// 2.5.3); the alt text follows it, hidden, so several buttons tell apart.
export const EXPAND_CLASS = 'md-expand';

function isCapped(img: HTMLImageElement): boolean {
  // The height the width alone would give; shorter than that means the cap
  // bit. (A computed max-height is a math function, not a number.)
  const room = img.parentElement?.parentElement?.clientWidth ?? 0;
  if (room <= 0 || img.naturalWidth <= 0) return false;
  const byWidth =
    (img.naturalHeight * Math.min(img.naturalWidth, room)) / img.naturalWidth;
  return img.clientHeight > 0 && img.clientHeight < byWidth - 1;
}

function syncExpandControl(img: HTMLImageElement): void {
  const link = img.parentElement;
  if (link?.tagName !== 'A' || link.childNodes.length !== 1) return;
  const next = link.nextElementSibling;
  const existing = next?.classList.contains(EXPAND_CLASS) ? next : null;
  const capped = isCapped(img);
  if (!capped) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = EXPAND_CLASS;
  button.append('View larger');
  if (img.alt) {
    const alt = document.createElement('span');
    alt.className = 'md-expand-alt';
    alt.textContent = ` ${img.alt}`;
    button.append(alt);
  }
  link.after(button);
}
