// The tooltip a CI pill's segments share (#4422): "7 checks passed" on hover,
// on keyboard focus and on a tap, the same on every board that draws the pill.
//
// One tooltip element serves the whole page, placed in the top layer (a popover)
// so a pill inside a dialog is not covered and no row's overflow clips it.
// The pill stays one button with one tab stop. Its children take no pointer
// events (a poll redraws them, and a press must land on the button), so the
// segment under the pointer is found from coordinates, and the arrow keys move
// the tip between segments while the pill has focus.
//
// WCAG 2.2 SC 1.4.13 (dismissible, hoverable, persistent):
// https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html
// WAI-ARIA Authoring Practices, tooltip pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/

const TIP_ID = 'ci-pill-tip';
// How long the tip waits after the pointer leaves, so it can cross onto it.
const GRACE_MS = 250;
const MARGIN = 8;
const GAP = 6;

let tip: HTMLElement | null = null;
let owner: HTMLElement | null = null;
let active: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let watcher: ReturnType<typeof setInterval> | undefined;
// A touch press this recent on a pill makes the next click a real tap. A
// screen reader's double-tap sends a click with no press before it, and that
// must still open the pipeline.
const TAP_MS = 1000;
const attached = new WeakSet<HTMLElement>();

function segments(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.ci-seg[data-tip]'));
}

function segmentAt(root: HTMLElement, x: number, y: number) {
  return segments(root).find((s) => {
    const r = s.getBoundingClientRect();

    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
}

function cancelHide() {
  clearTimeout(hideTimer);
  hideTimer = undefined;
}

function scheduleHide() {
  cancelHide();
  hideTimer = setTimeout(hide, GRACE_MS);
}

function hide() {
  cancelHide();
  if (tip?.matches(':popover-open')) tip.hidePopover();
  owner?.removeAttribute('aria-describedby');
  owner = null;
  active = null;
  clearInterval(watcher);
  watcher = undefined;
  document.removeEventListener('keydown', onEscape, true);
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('scroll', hide, true);
}

// A poll or the stream redraws a pill under an open tip: the old node fires no
// leave or blur, so this follows the segment to its new node, or closes.
function follow() {
  if (!owner?.isConnected) return hide();
  if (active?.isConnected) return;
  const kind = [...(active?.classList ?? [])].find((c) =>
    c.startsWith('ci-seg-'),
  );
  const next = segments(owner).find((seg) =>
    seg.classList.contains(kind ?? ''),
  );
  if (next) show(owner, next);
  else hide();
}

function onEscape(e: KeyboardEvent) {
  // Dismissed without moving focus. One Escape does one thing: it stops here
  // rather than also closing a dialog or filter behind the tip.
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  hide();
}

function onOutside(e: Event) {
  if (e.target instanceof Node && tip?.contains(e.target)) return;
  hide();
}

function ensureTip(): HTMLElement {
  if (tip?.isConnected) return tip;
  const el = document.createElement('div');
  el.id = TIP_ID;
  el.className = 'ci-pill-tip';
  el.setAttribute('role', 'tooltip');
  el.setAttribute('popover', 'manual');
  el.addEventListener('pointerenter', cancelHide);
  el.addEventListener('pointerleave', scheduleHide);
  document.body.appendChild(el);
  tip = el;

  return el;
}

function place(el: HTMLElement, seg: HTMLElement) {
  const s = seg.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.max(
    MARGIN,
    Math.min(s.left + s.width / 2 - w / 2, window.innerWidth - MARGIN - w),
  );
  // Above the segment, or below it when there is no room above.
  const above = s.top - GAP - h;
  const top = above >= MARGIN ? above : s.bottom + GAP;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function show(root: HTMLElement, seg: HTMLElement) {
  cancelHide();
  const el = ensureTip();
  el.textContent = seg.dataset.tip ?? '';
  if (!el.matches(':popover-open')) el.showPopover();
  place(el, seg);
  if (owner !== root) {
    owner?.removeAttribute('aria-describedby');
    owner = root;
  }
  root.setAttribute('aria-describedby', TIP_ID);
  active = seg;
  watcher ??= setInterval(follow, 200);
  document.addEventListener('keydown', onEscape, true);
  document.addEventListener('pointerdown', onOutside, true);
  // The tip is fixed, so it would float away from its segment on a scroll.
  document.addEventListener('scroll', hide, { capture: true, passive: true });
}

// The segment the tip is on, for the arrow keys.
function activeIndex(root: HTMLElement): number {
  return owner === root && active ? segments(root).indexOf(active) : -1;
}

// Idempotent: the Main branches page keeps one button and redraws its contents.
export function attachSegmentTips(root: HTMLElement) {
  if (attached.has(root)) return;
  attached.add(root);
  let touchedAt = -Infinity;
  root.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.pointerType === 'touch') touchedAt = Date.now();
  });
  root.addEventListener('pointermove', (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const seg = segmentAt(root, e.clientX, e.clientY);
    if (seg) show(root, seg);
    else if (owner === root) scheduleHide();
  });
  root.addEventListener('pointerleave', (e: PointerEvent) => {
    if (e.pointerType !== 'touch' && owner === root) scheduleHide();
  });
  root.addEventListener('focus', () => {
    // Keyboard focus only: a press that focuses the button opens the pipeline.
    if (!root.matches(':focus-visible')) return;
    const [first] = segments(root);
    if (first) show(root, first);
  });
  root.addEventListener('blur', () => {
    if (owner === root) hide();
  });
  root.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const all = segments(root);
    if (all.length === 0) return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const at = activeIndex(root);
    const next = at < 0 ? 0 : Math.max(0, Math.min(all.length - 1, at + step));
    show(root, all[next]);
  });
  // Registered before the click that opens the pipeline, so a tap on a
  // segment shows its text instead. The word and the pill's body still open it.
  root.addEventListener('click', (e: MouseEvent) => {
    const touch =
      (e as PointerEvent).pointerType === 'touch' &&
      Date.now() - touchedAt < TAP_MS;
    const seg = touch ? segmentAt(root, e.clientX, e.clientY) : undefined;
    if (seg) {
      e.preventDefault();
      e.stopImmediatePropagation();
      show(root, seg);

      return;
    }
    if (owner === root) hide();
  });
}
