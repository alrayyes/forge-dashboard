// A pill's explanation, shown when the pill has keyboard focus. The native
// title only shows on hover, so a keyboard reader never saw it. The tip is
// the pill's sibling inside a host, hidden by the stylesheet until the pill
// matches :focus-visible, and the pill is described by it. It stays out of the
// pill so the pill's visible text still sits inside its accessible name
// (WCAG 2.5.3). Escape hides it without moving focus (WCAG 1.4.13), and it
// comes back on the next focus.
// https://github.com/alrayyes/forge-dashboard/issues/3999

let counter = 0;

/** The attribute the stylesheet reads to keep a dismissed tip hidden. */
export const TIP_DISMISSED = 'data-tip-dismissed';

/**
 * Wraps `pill` with a tip reading `text`: the pill is described by it and
 * Escape dismisses it. Returns the host to put where the pill would go.
 */
export function addPillTip(pill: HTMLElement, text: string) {
  const host = document.createElement('span');
  host.className = 'pill-tip-host';
  const tip = document.createElement('span');
  tip.className = 'pill-tip';
  tip.id = `pill-tip-${counter++}`;
  tip.setAttribute('role', 'tooltip');
  tip.textContent = text;
  host.append(pill, tip);
  pill.setAttribute('aria-describedby', tip.id);
  pill.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || host.hasAttribute(TIP_DISMISSED)) return;
    if (!pill.matches(':focus-visible')) return;
    host.setAttribute(TIP_DISMISSED, '');
    // Escape closes the dialog the pill may sit in; this press only closes the tip.
    event.preventDefault();
    event.stopPropagation();
  });
  pill.addEventListener('blur', () => host.removeAttribute(TIP_DISMISSED));
  return host;
}

/** Focuses the pill itself, whether or not a tip's host wraps it. */
export function focusPill(node: HTMLElement | undefined) {
  const pill = node?.classList.contains('pill-tip-host')
    ? node.firstElementChild
    : node;
  if (pill instanceof HTMLElement) pill.focus();
}
