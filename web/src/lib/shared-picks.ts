import {
  authorChoices,
  distinctValues,
  type FilterableItem,
  reconcilePick,
  releaseHeld,
  repoChoices,
  type SharedFilterState,
  touchKey,
} from './filters';
import { labelChipColors } from './label-color';
import {
  AUTHOR_CONFIG,
  joinLabels,
  type LabelFilterControl,
  labelKey,
  mountLabelFilter,
  mountPickFilter,
  type PickChoice,
  type PickFilterControl,
  parsePick,
  REPO_CONFIG,
} from './label-filter';

// The Label, Repo and Author controls of the shared filter bar, and the work
// the Dashboard and Insights pages both do around them: mounting them, offering
// each the choices the others leave, setting aside a saved pick the page does
// not offer, and redrawing a control only when what it shows has changed.

export type PickKey = 'label' | 'repo' | 'author';

export interface PickHosts {
  label?: HTMLElement | null;
  repo?: HTMLElement | null;
  author?: HTMLElement | null;
}

// The items each control offers from: the pool with every other filter
// applied but its own.
export type PickPools = (key: PickKey) => FilterableItem[];

// A pick filter earns its place in the bar when it can narrow the list, or
// when it holds a pick the reader may want to clear (#3496). Over a single row
// it can only empty the list, so it goes unless it holds a pick (#3886).
// `rows` is the list it chooses from; left out, only the choices count.
export function pickFilterVisible(
  choices: number,
  picked: number,
  rows = Number.POSITIVE_INFINITY,
): boolean {
  return (choices > 1 && rows > 1) || picked > 0;
}

const FOCUSABLE = 'button, select, input, a[href]';

function focusableIn(
  start: Element | null,
  dir: 'previousElementSibling' | 'nextElementSibling',
): HTMLElement | null {
  for (let el = start; el; el = el[dir]) {
    if (!(el instanceof HTMLElement) || el.hidden) continue;
    const target = el.matches(FOCUSABLE)
      ? el
      : el.querySelector<HTMLElement>(FOCUSABLE);
    if (target && !(target as HTMLButtonElement).disabled) return target;
  }
  return null;
}

// Hides or shows a pick filter's host. When it hides with focus inside, focus
// goes to the nearest control before it (else after it), then to `fallback`
// (the filter bar), not the page body. `hadFocus` is whether focus was inside
// before the control redrew: a redraw that replaces the focused button has
// already dropped it to the body by the time this runs (#4748).
function setVisible(
  host: HTMLElement | null | undefined,
  visible: boolean,
  hadFocus: boolean,
  fallback?: (from: Element) => void,
) {
  if (!host || host.hidden === !visible) return;
  const handOff =
    !visible && (hadFocus || host.contains(document.activeElement));
  const next = handOff
    ? (focusableIn(host.previousElementSibling, 'previousElementSibling') ??
      focusableIn(host.nextElementSibling, 'nextElementSibling'))
    : null;
  host.hidden = !visible;
  // After the host is hidden, so the bar's search for a control that is drawn
  // does not land on this one.
  if (next) next.focus({ preventScroll: true });
  else if (handOff) fallback?.(host);
}

export class SharedPicks {
  label: LabelFilterControl | null = null;
  repo: PickFilterControl | null = null;
  author: PickFilterControl | null = null;
  // What the repo and author controls offer now, for the filter chips.
  repoChoices: PickChoice[] = [];
  authorChoices: PickChoice[] = [];
  private labelColors: ReadonlyMap<string, string> = new Map();
  private drawn: Partial<Record<PickKey, string>> = {};

  constructor(
    // A repo's logo by forge-qualified key.
    private readonly logoFor: (key: string) => string | undefined,
    // Where focus goes when a control hides under it and has no neighbour to
    // hand it to: the page's filter bar.
    private readonly focusBar?: (from: Element) => void,
  ) {}

  private hosts: PickHosts = {};

  mount(hosts: PickHosts, onPick: (key: PickKey, next: string[]) => void) {
    if (hosts.label)
      this.label = mountLabelFilter(hosts.label, (next) =>
        onPick('label', next),
      );
    if (hosts.repo)
      this.repo = mountPickFilter(hosts.repo, REPO_CONFIG, (next) =>
        onPick('repo', next),
      );
    if (hosts.author)
      this.author = mountPickFilter(hosts.author, AUTHOR_CONFIG, (next) =>
        onPick('author', next),
      );
    this.hosts = hosts;
    this.drawn = {};
  }

  // Says a line to a screen reader from the control that changed.
  announce(key: PickKey, text: string) {
    this[key]?.announce(text);
  }

  destroy() {
    this.label?.destroy();
    this.repo?.destroy();
    this.author?.destroy();
  }

  // Reconciles the three saved picks with what the page offers and redraws
  // each control whose choices or ticks changed. True if a pick was set aside.
  // `hold` keeps it in the saved copy for a page that does offer it.
  refresh(state: SharedFilterState, pools: PickPools, hold: boolean): boolean {
    const repoOffered = repoChoices(pools('repo'), this.logoFor);
    const staleRepo = reconcilePick(
      state,
      'repo',
      repoOffered.map((c) => c.value),
      hold,
    );
    this.repoChoices = repoOffered;
    this.draw('repo', repoOffered, state, pools('repo').length);

    const authorOffered = authorChoices(pools('author'));
    const staleAuthor = reconcilePick(
      state,
      'author',
      authorOffered.map((c) => c.value),
      hold,
    );
    this.authorChoices = authorOffered;
    this.draw('author', authorOffered, state, pools('author').length);

    const labelPool = pools('label');
    const labels = distinctValues(
      (item) => (item.labels || []).map((l) => l.name),
      labelPool,
    );
    const staleLabel = reconcilePick(state, 'label', labels, hold);
    this.labelColors = labelChipColors(labelPool);
    this.draw(
      'label',
      labels.map((name) => ({
        value: name,
        text: name,
        chip: { color: this.labelColors.get(labelKey(name)) },
      })),
      state,
      labelPool.length,
    );
    return staleRepo || staleAuthor || staleLabel;
  }

  private draw(
    key: PickKey,
    choices: PickChoice[],
    state: SharedFilterState,
    rows: number,
  ) {
    const picked = parsePick(state.shared[key]);
    const signature = JSON.stringify([choices, picked, rows > 1]);
    if (this.drawn[key] === signature) return;
    this.drawn[key] = signature;
    const host = this.hosts[key];
    const hadFocus = host?.contains(document.activeElement) ?? false;
    if (key === 'label')
      this.label?.render(
        choices.map((c) => c.value),
        picked,
        this.labelColors,
      );
    else this[key]?.render(choices, picked);
    setVisible(
      host,
      pickFilterVisible(choices.length, picked.length, rows),
      hadFocus,
      this.focusBar,
    );
  }
}

// Takes a new pick for one control into the state, as every pick is saved:
// lowercase values joined by a newline. It is the user's own change, so a
// value of that kind set aside earlier is let go, and the key is marked as
// touched for the merge with the server's copy.
export function savePick(
  state: SharedFilterState,
  key: PickKey,
  next: string[],
) {
  state.shared[key] = joinLabels(next);
  touchKey('shared', key);
  releaseHeld('shared', key);
}
