// The Copy button beside a failed action (#1323), shared by the row's failure
// line, its toast and the pipeline panel's rerun failure.

import type { FailureDetails } from './feedback';

// How long the button says Copied before it says Copy again.
const COPIED_MS = 2000;

// Copy for a failed action (#1323): the server's whole answer as JSON, which
// the row never shows. Where the clipboard is unavailable (an insecure
// context, a refused permission) the same text is shown in a box to select,
// instead of the button failing without a word.
export function copyButton(
  details: FailureDetails,
  className: string,
): HTMLElement {
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = className;
  copy.textContent = 'Copy';
  copy.setAttribute('aria-label', 'Copy error details');
  copy.addEventListener('click', () => {
    const text = JSON.stringify(details, null, 2);
    const done = () => {
      copy.textContent = 'Copied';
      window.setTimeout(() => {
        if (copy.isConnected) copy.textContent = 'Copy';
      }, COPIED_MS);
    };
    const fallback = () => showDetails(copy, text);
    try {
      navigator.clipboard.writeText(text).then(done, fallback);
    } catch {
      fallback();
    }
  });
  return copy;
}

// The details in a read-only box right after the line or toast the button is
// in, selected so a keyboard or a long press can copy them.
function showDetails(copy: HTMLElement, text: string) {
  const host = copy.closest(
    '.row-feedback-line, .feedback-toast, .pipeline-rerun-failure',
  );
  if (!host) return;
  // In a toast or the pipeline panel the box goes inside (a list item may not
  // hold a stray sibling); on a row it follows the line.
  const inToast =
    host.classList.contains('feedback-toast') ||
    host.classList.contains('pipeline-rerun-failure');
  const container = inToast ? host : host.parentElement;
  let box = container?.querySelector<HTMLTextAreaElement>(
    ':scope > .feedback-details',
  );
  if (!box) {
    box = document.createElement('textarea');
    box.className = 'feedback-details';
    box.readOnly = true;
    box.rows = 8;
    box.setAttribute('aria-label', 'Error details');
    if (inToast) host.appendChild(box);
    else host.after(box);
  }
  box.value = text;
  box.focus();
  box.select();
}
