// Escape hides a tooltip for as long as its control keeps the pointer or focus
// (WCAG 1.4.13, dismissible). The host gets data-tip-dismissed; the stylesheet
// hides the tip, and leaving the control clears it.
export function tipDismiss(host: HTMLElement) {
  const clear = () => host.removeAttribute('data-tip-dismissed');
  const onKey = (e: KeyboardEvent) => {
    if (
      e.key === 'Escape' &&
      (host.matches(':hover') || host.matches(':focus-within'))
    ) {
      host.setAttribute('data-tip-dismissed', '');
    }
  };
  document.addEventListener('keydown', onKey);
  host.addEventListener('mouseleave', clear);
  host.addEventListener('focusout', clear);
  return {
    destroy() {
      document.removeEventListener('keydown', onKey);
      host.removeEventListener('mouseleave', clear);
      host.removeEventListener('focusout', clear);
    },
  };
}
