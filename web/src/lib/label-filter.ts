// The Label filter: pick several labels, see what carries any of them.
//
// The pick is saved as one string in the shared filters, as it always was, so
// a single label saved before there was a list reads back as a list of one and
// nothing needs migrating. Several labels are joined with a newline, which a
// label name does not contain (the forges trim and reject line breaks), unlike
// a comma or a space. Picks are lowercase, like every saved pick, and the page
// matches without regard to case.

const SEPARATOR = '\n';
const HINT = 'Shows items with any of the ticked labels.';

// The pick is a cookie value and a server field, and grows with each label, so
// it is held to a size a cookie carries. The server refuses a save over either.
export const MAX_LABELS = 20;
export const MAX_CHARS = 1000;

// A label as the pick holds it: lowercase, and with any control character
// (a line break, a tab) turned into a space, so a name can never split into
// two picks. The page matches items on this too, so such a label still
// matches itself.
export function labelKey(name: string): string {
  return name
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function parseLabels(saved: string | undefined): string[] {
  const seen = new Set<string>();
  let chars = 0;
  for (const part of (saved ?? '').split(SEPARATOR)) {
    const name = labelKey(part);
    if (!name || seen.has(name)) continue;
    if (seen.size >= MAX_LABELS) break;
    const size = [...name].length + (seen.size > 0 ? 1 : 0);
    if (chars + size > MAX_CHARS) continue;
    chars += size;
    seen.add(name);
  }
  return [...seen];
}

export function joinLabels(labels: string[]): string {
  return parseLabels(labels.join(SEPARATOR)).join(SEPARATOR);
}

export function hasLabel(labels: string[], name: string): boolean {
  return labels.includes(labelKey(name));
}

// Ticks the label when it is not picked, unticks it when it is. A label that
// would take the pick past its size is not ticked.
export function toggleLabel(labels: string[], name: string): string[] {
  const key = labelKey(name);
  if (hasLabel(labels, key)) return labels.filter((l) => l !== key);
  const next = parseLabels([...labels, key].join(SEPARATOR));
  return next.includes(key) ? next : labels;
}

// What of a pick the page still offers (kept) and what it does not (dropped),
// so a label nothing carries any more is not silently left filtering.
export function narrowLabels(
  picked: string[],
  offered: string[],
): { kept: string[]; dropped: string[] } {
  const on = new Set(offered.map(labelKey));
  return {
    kept: picked.filter((p) => on.has(p)),
    dropped: picked.filter((p) => !on.has(p)),
  };
}

// The saved copy keeps what this page set aside for the page that offers it
// (#1620's held picks), next to what is picked here.
export function unionLabels(picked: string, setAside: string): string {
  return joinLabels([...parseLabels(picked), ...parseLabels(setAside)]);
}

// Does an item carry any of the picked labels? Nothing picked lets it through.
export function carriesAny(
  itemLabels: { name: string }[] | undefined,
  saved: string | undefined,
): boolean {
  const picked = parseLabels(saved);
  if (picked.length === 0) return true;
  return (itemLabels ?? []).some((l) => picked.includes(labelKey(l.name)));
}

// What the control's button says: one label by name as the page writes it, or
// how many.
export function labelSummary(picked: string[], offered: string[]): string {
  if (picked.length === 0) return 'All labels';
  if (picked.length > 1) return `${picked.length} labels`;
  return offered.find((o) => labelKey(o) === picked[0]) ?? picked[0];
}

export interface LabelFilterControl {
  // Redraws the choices and which are ticked, leaving the open panel and the
  // focused box where they are.
  render(offered: string[], picked: string[]): void;
  // Says a line to a screen reader, politely, once.
  announce(text: string): void;
  // Takes the page-wide listener off when the page goes.
  destroy(): void;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// A group of checkboxes behind a disclosure button, not a native
// <select multiple> or an ARIA listbox: those have tested poorly with screen
// readers and on phones for years, while checkboxes in a fieldset are plain
// HTML every assistive technology already speaks.
// https://adrianroselli.com/2022/05/under-engineered-multi-selects.html
// https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/
export function mountLabelFilter(
  host: HTMLElement,
  onChange: (picked: string[]) => void,
): LabelFilterControl {
  const id = host.id || 'label-filter';
  host.classList.add('label-filter');

  const button = node('button', 'label-filter-button col-filter');
  button.type = 'button';
  button.id = `${id}-button`;
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', `${id}-panel`);

  const panel = node('div', 'label-filter-panel');
  panel.id = `${id}-panel`;
  panel.hidden = true;

  const group = node('fieldset', 'label-filter-group');
  group.appendChild(node('legend', 'label-filter-legend', 'Label'));
  const hint = node('p', 'label-filter-hint', HINT);
  group.appendChild(hint);
  const options = node('div', 'label-filter-options');
  const empty = node('p', 'label-filter-empty', 'No labels on this page.');
  group.append(options, empty);

  const clear = node('button', 'label-filter-clear', 'Clear labels');
  clear.type = 'button';
  panel.append(group, clear);

  const status = node('span', 'sr-only');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');

  host.replaceChildren(button, panel, status);

  let offeredNow: string[] = [];
  let pickedNow: string[] = [];

  // The group opens under the button, left edges level. When the button is
  // near the right of the window that would run off it, so the right edges
  // line up instead.
  function placePanel() {
    panel.classList.remove('align-end');
    const right = panel.getBoundingClientRect().right;
    if (right > document.documentElement.clientWidth - 8)
      panel.classList.add('align-end');
  }

  function close(refocus: boolean) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  }

  button.addEventListener('click', () => {
    if (panel.hidden) {
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      placePanel();
    } else close(false);
  });
  host.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      // The panel closes, not the Filters sheet around it.
      event.stopPropagation();
      event.preventDefault();
      close(true);
    }
  });
  host.addEventListener('focusout', (event) => {
    const next = event.relatedTarget as Node | null;
    if (next && !host.contains(next)) close(false);
  });
  const onOutside = (event: Event) => {
    if (!host.contains(event.target as Node)) close(false);
  };
  document.addEventListener('pointerdown', onOutside);
  options.addEventListener('change', (event) => {
    const box = event.target as HTMLInputElement;
    onChange(toggleLabel(pickedNow, box.value));
  });
  clear.addEventListener('click', () => {
    onChange([]);
    button.focus();
  });

  function render(offered: string[], picked: string[]) {
    // One box per label, whatever its case.
    const seen = new Set<string>();
    offeredNow = offered.filter((o) => {
      const key = labelKey(o);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    pickedNow = picked;

    const rows = new Map<string, HTMLLabelElement>();
    for (const child of Array.from(options.children)) {
      const row = child as HTMLLabelElement;
      rows.set(row.dataset.label ?? '', row);
    }
    let previous: Element | null = null;
    for (const name of offeredNow) {
      const key = labelKey(name);
      let row = rows.get(key);
      if (!row) {
        row = node('label', 'label-filter-option');
        row.dataset.label = key;
        const box = node('input');
        box.type = 'checkbox';
        box.value = key;
        row.append(box, node('span', undefined, name));
      }
      rows.delete(key);
      const text = row.querySelector('span');
      if (text && text.textContent !== name) text.textContent = name;
      const box = row.querySelector('input');
      if (box) {
        box.checked = picked.includes(key);
        // At the most, only a ticked box can still be changed.
        box.disabled = !box.checked && picked.length >= MAX_LABELS;
      }
      const wanted: Node | null = previous
        ? previous.nextElementSibling
        : options.firstChild;
      if (wanted !== row) options.insertBefore(row, wanted);
      previous = row;
    }
    for (const row of rows.values()) row.remove();

    empty.hidden = offeredNow.length > 0;
    clear.disabled = picked.length === 0;
    const full =
      picked.length >= MAX_LABELS ? `${HINT} Up to ${MAX_LABELS}.` : HINT;
    if (hint.textContent !== full) hint.textContent = full;
    const summary = labelSummary(picked, offeredNow);
    if (button.textContent !== summary) button.textContent = summary;
    button.setAttribute('aria-label', `Filter by label: ${summary}`);
  }

  render([], []);

  return {
    render,
    destroy() {
      document.removeEventListener('pointerdown', onOutside);
    },
    announce(text) {
      status.textContent = '';
      // A changed node is what a live region speaks; the same text twice in a
      // row needs a beat between.
      setTimeout(() => {
        status.textContent = text;
      }, 50);
    },
  };
}
