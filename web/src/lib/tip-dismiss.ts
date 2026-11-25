// Escape hides a tooltip for as long as its control keeps the pointer or focus
// (WCAG 1.4.13, dismissible). It serves every CSS tooltip: the repo controls
// and the wait chip. The host gets data-tip-dismissed; the stylesheet hides
// the tip (see "Shared tooltip rules" in style.css), and it stays hidden until
// the pointer and focus have both left the host.
const HOST = '[data-tip-host]';

let escapeBound = false;
function bindEscape(): void {
  if (escapeBound || typeof document === 'undefined') return;
  escapeBound = true;
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    for (const host of document.querySelectorAll<HTMLElement>(
      `${HOST}:hover, ${HOST}:focus-within`,
    )) {
      host.setAttribute('data-tip-dismissed', '');
    }
  });
}

export function tipDismiss(host: HTMLElement) {
  host.setAttribute('data-tip-host', '');
  const reopen = () => {
    if (!host.matches(':hover, :focus-within')) {
      host.removeAttribute('data-tip-dismissed');
    }
  };
  const onFocusOut = () => queueMicrotask(reopen);
  bindEscape();
  host.addEventListener('pointerleave', reopen);
  host.addEventListener('focusout', onFocusOut);
  return {
    destroy() {
      host.removeEventListener('pointerleave', reopen);
      host.removeEventListener('focusout', onFocusOut);
    },
  };
}
