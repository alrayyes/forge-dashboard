// Draws feedback.ts's state: the inline status line on a row, the
// bottom-right toast stack, the Activity control and panel, and the one
// polite live region that speaks each event once (#714).
//
// WCAG 4.1.3 Status Messages: a message the user didn't ask to move focus
// to is announced through a role, not by stealing focus. Only
// #feedback-live is live; toasts and the panel are plain markup so a
// message isn't read twice. WCAG 2.2.1 Timing Adjustable: nothing that
// needs action (an error, a timeout) auto-dismisses, and a success toast
// pauses while hovered or focused.

import {
  type ActivityEntry,
  type FeedbackStore,
  isFinished,
  PHASE_LABELS,
  type Toast,
} from './feedback';

// How long a success toast stays before it dismisses itself.
export const TOAST_LIFETIME_MS = 6000;

export type FeedbackUIOptions = {
  // The "(next refresh in 12s)" / " Refreshing…" text. Only ever shown
  // aria-hidden: a number that changes each second must not be spoken.
  countdownText: () => string;
};

function node(tag: string, className = '', text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function button(className: string, text: string, label = ''): HTMLElement {
  const b = node('button', className, text) as HTMLButtonElement;
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
}

function refText(ref: { repo: string; number: number }): string {
  return `${ref.repo}#${ref.number}`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

type ToastTimer = {
  remaining: number;
  startedAt: number;
  handle: number | null;
  hovered: boolean;
  focused: boolean;
};

export function mountFeedbackUI(
  store: FeedbackStore,
  options: FeedbackUIOptions,
) {
  const live = document.getElementById('feedback-live');
  const toastList = document.getElementById('feedback-toasts');
  const toggle = document.getElementById(
    'activity-toggle',
  ) as HTMLButtonElement | null;
  const panel = document.getElementById('activity-panel');
  const panelList = panel?.querySelector<HTMLElement>('.activity-list');
  const clearButton =
    panel?.querySelector<HTMLButtonElement>('.activity-clear');

  // ---- Show row ----
  function rowElement(key: string): HTMLElement | null {
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>('#pr-rows .row[data-pr-key]'),
    )) {
      if (row.dataset.prKey === key) return row;
    }
    return null;
  }

  function showRow(ref: { key: string; repo: string; number: number }) {
    const row = rowElement(ref.key);
    if (!row) {
      // Merged or closed, filtered out, or on another page of the list.
      announce(
        `${refText(ref)}: that row isn't on the page right now. It may be filtered out, on another page, or gone.`,
      );
      return;
    }
    row.scrollIntoView({
      block: 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    row.focus({ preventScroll: true });
  }

  // ---- the one live region ----
  let announceHandle: number | null = null;
  function announce(message: string) {
    if (!live) return;
    // Cleared first so the same sentence twice in a row is still two
    // events to a screen reader.
    live.textContent = '';
    if (announceHandle !== null) window.clearTimeout(announceHandle);
    announceHandle = window.setTimeout(() => {
      live.textContent = message;
      announceHandle = null;
    }, 30);
  }
  store.onAnnounce(announce);

  // ---- countdown ----
  function countdownNode(): HTMLElement {
    const c = node('span', 'feedback-countdown', options.countdownText());
    c.setAttribute('aria-hidden', 'true');
    return c;
  }

  function tick() {
    for (const c of Array.from(
      document.querySelectorAll<HTMLElement>('.feedback-countdown'),
    )) {
      c.textContent = options.countdownText();
    }
  }

  // ---- inline status line ----
  function lineText(entry: ActivityEntry): string {
    switch (entry.phase) {
      case 'queued':
        return `${entry.inline}. Awaiting the next refresh.`;
      case 'failed':
        return `Failed: ${entry.inline}`;
      case 'expired':
        return `Timed out: ${entry.inline}`;
      default:
        return entry.inline;
    }
  }

  // A successful finish has nothing left to say on the row: it shows up as
  // a toast and in Activity.
  function inlineEntries(key: string): ActivityEntry[] {
    return store.entriesFor(key).filter((e) => e.phase !== 'done');
  }

  function signature(key: string): string {
    return inlineEntries(key)
      .map((e) => `${e.id}|${e.phase}|${e.inline}`)
      .join(';');
  }

  function buildInline(key: string): HTMLElement | null {
    const entries = inlineEntries(key);
    if (entries.length === 0) return null;
    const wrap = node('div', 'row-feedback');
    for (const entry of entries) {
      const line = node('div', 'row-feedback-line');
      line.dataset.phase = entry.phase;
      line.appendChild(node('span', 'row-feedback-text', lineText(entry)));
      if (entry.phase === 'queued') {
        line.appendChild(document.createTextNode(' '));
        line.appendChild(countdownNode());
      }
      if (
        (entry.phase === 'failed' || entry.phase === 'expired') &&
        entry.canRetry &&
        entry.retry
      ) {
        const retry = button(
          'row-action row-feedback-retry',
          'Retry',
          `Retry for ${refText(entry.ref)}`,
        );
        const run = entry.retry;
        retry.addEventListener('click', () => run());
        line.appendChild(retry);
      }
      wrap.appendChild(line);
    }
    return wrap;
  }

  // Called by buildRow for every pull request row, and again by syncRows
  // when a row's entries change.
  function decorateRow(row: HTMLElement, key: string) {
    row.dataset.prKey = key;
    row.tabIndex = -1;
    row.dataset.feedbackSig = signature(key);
    row.querySelector(':scope > .row-feedback')?.remove();
    const inline = buildInline(key);
    if (inline) row.appendChild(inline);
  }

  function syncRows() {
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>('#pr-rows .row[data-pr-key]'),
    )) {
      const key = row.dataset.prKey ?? '';
      if (row.dataset.feedbackSig !== signature(key)) decorateRow(row, key);
    }
  }

  // ---- toasts ----
  const toastNodes = new Map<number, HTMLElement>();
  const timers = new Map<number, ToastTimer>();

  function startTimer(id: number) {
    const timer = timers.get(id);
    if (!timer || timer.handle !== null) return;
    if (timer.hovered || timer.focused) return;
    timer.startedAt = Date.now();
    timer.handle = window.setTimeout(
      () => store.dismissToast(id),
      timer.remaining,
    );
  }

  function pauseTimer(id: number) {
    const timer = timers.get(id);
    if (!timer || timer.handle === null) return;
    window.clearTimeout(timer.handle);
    timer.handle = null;
    timer.remaining = Math.max(
      1000,
      timer.remaining - (Date.now() - timer.startedAt),
    );
  }

  function buildToast(toast: Toast): HTMLElement {
    const item = node('li', 'feedback-toast');
    item.dataset.kind = toast.kind;
    const head = node('div', 'feedback-toast-head');
    head.appendChild(node('span', 'feedback-toast-ref', refText(toast.ref)));
    const dismiss = button(
      'feedback-toast-dismiss',
      '×',
      `Dismiss notification for ${refText(toast.ref)}`,
    );
    dismiss.addEventListener('click', () => store.dismissToast(toast.id));
    head.appendChild(dismiss);
    item.appendChild(head);
    item.appendChild(node('p', 'feedback-toast-message', toast.message));
    const foot = node('div', 'feedback-toast-foot');
    const show = button('feedback-link', 'Show row');
    show.addEventListener('click', () => showRow(toast.ref));
    foot.appendChild(show);
    if (toast.retry) {
      const run = toast.retry;
      const retry = button('feedback-link', 'Retry');
      retry.addEventListener('click', () => {
        store.dismissToast(toast.id);
        run();
      });
      foot.appendChild(retry);
    }
    item.appendChild(foot);

    if (toast.kind === 'success') {
      const timer: ToastTimer = {
        remaining: TOAST_LIFETIME_MS,
        startedAt: 0,
        handle: null,
        hovered: false,
        focused: false,
      };
      timers.set(toast.id, timer);
      item.addEventListener('mouseenter', () => {
        timer.hovered = true;
        pauseTimer(toast.id);
      });
      item.addEventListener('mouseleave', () => {
        timer.hovered = false;
        startTimer(toast.id);
      });
      item.addEventListener('focusin', () => {
        timer.focused = true;
        pauseTimer(toast.id);
      });
      item.addEventListener('focusout', (event) => {
        if (item.contains((event as FocusEvent).relatedTarget as Node | null))
          return;
        timer.focused = false;
        startTimer(toast.id);
      });
    }
    return item;
  }

  function renderToasts() {
    if (!toastList) return;
    const visible = store.visibleToasts();
    const keep = new Set(visible.map((t) => t.id));
    for (const [id, el] of Array.from(toastNodes)) {
      if (keep.has(id)) continue;
      // Focus on a dismissed toast would fall to <body>; hand it to the
      // next sensible place, the Activity control.
      if (el.contains(document.activeElement)) toggle?.focus();
      el.remove();
      toastNodes.delete(id);
      const timer = timers.get(id);
      if (timer?.handle != null) window.clearTimeout(timer.handle);
      timers.delete(id);
    }
    // Newest first, in the DOM too, so reading order matches what's seen.
    let previous: Element | null = null;
    for (const toast of visible) {
      let el = toastNodes.get(toast.id);
      if (!el) {
        el = buildToast(toast);
        toastNodes.set(toast.id, el);
      }
      const expected: ChildNode | null = previous
        ? previous.nextSibling
        : toastList.firstChild;
      if (el !== expected) toastList.insertBefore(el, expected);
      previous = el;
      startTimer(toast.id);
    }
  }

  // ---- activity control and panel ----
  function activityItem(entry: ActivityEntry): HTMLElement {
    const item = node('li', 'activity-item');
    item.dataset.phase = entry.phase;
    const head = node('div', 'activity-item-head');
    head.appendChild(node('span', 'activity-ref', refText(entry.ref)));
    head.appendChild(node('span', 'activity-phase', PHASE_LABELS[entry.phase]));
    item.appendChild(head);
    const body = node(
      'p',
      'activity-message',
      `${entry.label}: ${entry.message}`,
    );
    if (entry.phase === 'queued') {
      body.appendChild(document.createTextNode(' '));
      body.appendChild(countdownNode());
    }
    item.appendChild(body);
    const show = button('feedback-link', 'Show row');
    show.addEventListener('click', () => {
      closePanel(false);
      showRow(entry.ref);
    });
    item.appendChild(show);
    return item;
  }

  let panelSig = '';
  function renderPanel() {
    const entries = store.entries();
    if (toggle) toggle.textContent = `Activity ${entries.length}`;
    if (clearButton)
      clearButton.disabled = !entries.some((e) => isFinished(e.phase));
    if (!panelList) return;
    const sig = entries.map((e) => `${e.id}|${e.phase}|${e.message}`).join(';');
    if (sig === panelSig) return;
    panelSig = sig;
    panelList.replaceChildren();
    if (entries.length === 0) {
      panelList.appendChild(node('li', 'activity-empty', 'No actions yet.'));
      return;
    }
    for (const entry of entries) panelList.appendChild(activityItem(entry));
  }

  function openPanel() {
    if (!panel || !toggle) return;
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  }

  function closePanel(returnFocus: boolean) {
    if (!panel || !toggle || panel.hidden) return;
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (returnFocus) toggle.focus();
  }

  toggle?.addEventListener('click', () => {
    if (panel?.hidden) openPanel();
    else closePanel(true);
  });
  clearButton?.addEventListener('click', () => store.clearFinished());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel && !panel.hidden) closePanel(true);
  });
  document.addEventListener('click', (event) => {
    if (!panel || panel.hidden) return;
    const target = event.target as Node;
    if (panel.contains(target) || toggle?.contains(target)) return;
    closePanel(false);
  });

  function render() {
    renderToasts();
    renderPanel();
    syncRows();
  }
  store.subscribe(render);
  render();

  return { decorateRow, syncRows, tick };
}
