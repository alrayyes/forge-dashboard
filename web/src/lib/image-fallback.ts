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
  node.addEventListener('error', onError, true);
  return { destroy: () => node.removeEventListener('error', onError, true) };
}
