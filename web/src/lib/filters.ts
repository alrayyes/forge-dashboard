// Shared filter state and matching, used by both the main dashboard and
// Insights — the one place their filter behavior is implemented instead of
// two independently maintained copies.

export interface SharedFilterState {
  shared: Record<string, string>;
  pr: Record<string, string>;
  issue: Record<string, string>;
}

export interface FilterableItem {
  forge: string;
  repo: string;
  title: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  ci?: string;
  labels?: { name: string }[];
}

export const FORGE_LABELS: Record<string, string> = {
  github: 'GitHub',
  forgejo: 'Forgejo',
};
export const DEPENDENCY_DASHBOARD_TITLE = 'Dependency Dashboard';
const FILTERS_COOKIE = 'forge-board-filters';

function getCookie(name: string): string | null {
  const match = document.cookie.match(
    new RegExp(
      `(?:^|; )${name.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`,
    ),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string): void {
  const maxAgeSeconds = 365 * 24 * 60 * 60;
  // Cookie Store API isn't in Safari yet, and this repo targets more than just Chromium (browser-compat.md).
  // biome-ignore lint/suspicious/noDocumentCookie: see above.
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

// One shared object (forge/repo/label/author/title/created/updated/
// groupBy) plus two board-owned extras with no equivalent on the other
// entity type. An older {pr:{...}, issue:{...}} cookie from before this
// shape simply matches none of these keys and reads back as defaults: a
// one-time silent reset, not a migration to write and later delete.
function defaultState(): SharedFilterState {
  return {
    shared: {},
    pr: {},
    issue: { hideDependencyDashboard: '1' },
  };
}

export function loadState(): SharedFilterState {
  const raw = getCookie(FILTERS_COOKIE);
  const state = defaultState();
  if (!raw) return state;
  let parsed: Partial<SharedFilterState> | null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (!parsed || typeof parsed !== 'object') return state;
  if (parsed.shared && typeof parsed.shared === 'object')
    Object.assign(state.shared, parsed.shared);
  if (parsed.pr && typeof parsed.pr === 'object')
    Object.assign(state.pr, parsed.pr);
  if (parsed.issue && typeof parsed.issue === 'object')
    Object.assign(state.issue, parsed.issue);
  return state;
}

const FILTER_STATE_ENDPOINT = '/api/settings/filter-state';
// Long enough that a fast typist's keystrokes coalesce into one write,
// short enough that a real pause reads as "done typing," matching the
// "debounce free text, not discrete controls" split #353 asks for —
// see saveState's own comment for which callers hit which path.
const TITLE_SAVE_DEBOUNCE_MS = 500;
let titleSaveTimer: ReturnType<typeof setTimeout> | null = null;

function putFilterStateToServer(state: SharedFilterState): void {
  fetch(FILTER_STATE_ENDPOINT, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  }).catch(() => {
    // Best-effort, the same restraint RecordWebhookDelivery's own
    // server-side "a failure to persist this doesn't fail the request
    // it's riding along with" gets — the cookie already has this
    // value locally regardless, so a lost sync here just means the
    // next device to load stays on its own last-synced state instead
    // of today's, not a broken filter bar.
  });
}

// Writes the cookie synchronously and immediately, every call — the
// same fast local cache theme's own cookie already is, and what lets
// loadState() stay synchronous for the page's very first paint.
// The server sync is what debouncedCol controls: pass the column that
// just changed when it was a free-text keystroke (only "title" today)
// to delay that one; omit it (every discrete control — a <select>, a
// radio, a checkbox, "Clear filters," a label chip click) to sync
// immediately, flushing any debounced title write still pending first
// so the two can never land out of order.
export function saveState(
  state: SharedFilterState,
  debouncedCol?: string,
): void {
  try {
    setCookie(FILTERS_COOKIE, JSON.stringify(state));
  } catch {
    /* ignore */
  }

  if (debouncedCol === 'title') {
    if (titleSaveTimer) clearTimeout(titleSaveTimer);
    titleSaveTimer = setTimeout(() => {
      titleSaveTimer = null;
      putFilterStateToServer(state);
    }, TITLE_SAVE_DEBOUNCE_MS);
    return;
  }
  if (titleSaveTimer) {
    clearTimeout(titleSaveTimer);
    titleSaveTimer = null;
  }
  putFilterStateToServer(state);
}

// Fetches the signed-in user's own saved filter state from the server
// (#353) — a separate, async step from loadState's own synchronous
// cookie read, called once at page load right after it so the first
// paint isn't blocked on a round trip. Returns null on any failure or
// for a user who's never saved anything server-side yet (the {}
// GET /api/settings/filter-state answers with either way), the
// caller's own signal to leave the cookie-derived state as it is
// rather than overwriting it with nothing.
export function loadStateFromServer(): Promise<Partial<SharedFilterState> | null> {
  return fetch(FILTER_STATE_ENDPOINT, {
    headers: { Accept: 'application/json' },
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((parsed: Partial<SharedFilterState> | null) => {
      if (!parsed || typeof parsed !== 'object') return null;
      if (
        (!parsed.shared || Object.keys(parsed.shared).length === 0) &&
        (!parsed.pr || Object.keys(parsed.pr).length === 0) &&
        (!parsed.issue || Object.keys(parsed.issue).length === 0)
      ) {
        return null;
      }
      return parsed;
    })
    .catch(() => null);
}

// Merges got (a real server response from loadStateFromServer, already
// known non-null) into state in place — mutated, not reassigned, since
// callers close over this exact state object and a reassignment here
// would leave them all pointing at the stale one. Same per-key merge
// shape loadState's own cookie-parsing already uses, so a field the
// server never reports (an older save, before a field existed) doesn't
// clobber a default that already has something sensible.
export function applyServerState(
  state: SharedFilterState,
  got: Partial<SharedFilterState>,
): void {
  if (got.shared && typeof got.shared === 'object')
    Object.assign(state.shared, got.shared);
  if (got.pr && typeof got.pr === 'object') Object.assign(state.pr, got.pr);
  if (got.issue && typeof got.issue === 'object')
    Object.assign(state.issue, got.issue);
}

export function minutesAgo(iso: string): number {
  return Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60000),
  );
}

// shared carries the fields that apply to both pull requests and
// issues; extra carries whichever board-owned field applies to this
// item's own entity type (status for a pull request,
// hideDependencyDashboard for an issue) — the caller passes only the
// one relevant to isPR.
export function matchesFilters(
  item: FilterableItem,
  isPR: boolean,
  shared: Record<string, string>,
  extra: Record<string, string> | undefined,
): boolean {
  const repoKey = `${item.forge}:${item.repo}`.toLowerCase();
  if (shared.forge && item.forge !== shared.forge) return false;
  if (shared.repo && repoKey !== shared.repo) return false;
  if (shared.title && !item.title.toLowerCase().includes(shared.title))
    return false;
  if (
    shared.author &&
    !(item.author || '').toLowerCase().includes(shared.author)
  )
    return false;
  if (shared.created && minutesAgo(item.createdAt) > Number(shared.created))
    return false;
  if (shared.updated && minutesAgo(item.updatedAt) > Number(shared.updated))
    return false;
  if (
    shared.label &&
    !(item.labels || []).some((l) => l.name.toLowerCase() === shared.label)
  )
    return false;
  if (isPR && extra?.status && item.ci !== extra.status) return false;
  // Renovate's one permanently-open, constantly-rewritten housekeeping
  // issue per repo — never a pull request, so this only ever matches
  // on the issues board. Exact title match: that's the fixed title
  // Renovate itself always uses.
  if (
    !isPR &&
    extra?.hideDependencyDashboard &&
    item.title.trim() === DEPENDENCY_DASHBOARD_TITLE
  )
    return false;
  return true;
}

// Distinct, sorted values of getValues(item) across items — what both
// a filter <select>'s options and a filter <input>'s <datalist>
// suggestions are populated from. getValues returns either one value
// or an array of them (label — an item can carry several).
export function distinctValues(
  getValues: (item: FilterableItem) => string | string[] | undefined,
  items: FilterableItem[],
): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const vs = getValues(item);
    for (const v of Array.isArray(vs) ? vs : [vs]) {
      if (v) seen.add(v);
    }
  }
  return [...seen].sort();
}

// Rebuilds select's options (after its fixed first "All ..." option,
// written once in the HTML) from values, keeping previous selected if
// it's still among them. Returns true when previous was stale and got
// cleared — the caller's own signal to clear the underlying filter
// state too, not just the visible control, or it keeps silently
// filtering out everything on a value nothing can match, with no
// visible cause.
export function populateSelect(
  select: HTMLSelectElement | null,
  values: string[],
  previous: string,
): boolean {
  if (!select) return false;
  while (select.options.length > 1) select.remove(1);
  for (const v of values) {
    const option = document.createElement('option');
    option.value = v;
    option.textContent = v;
    select.appendChild(option);
  }
  if (values.includes(previous)) {
    select.value = previous;
    return false;
  }
  select.value = '';
  return Boolean(previous);
}

// Title is the one column that's genuinely open-ended free text — the
// datalist only adds suggestions from what's on screen, it doesn't
// restrict what can still be typed and substring-matched.
export function populateDatalist(
  datalist: HTMLDataListElement | null,
  values: string[],
): void {
  if (!datalist) return;
  datalist.innerHTML = '';
  for (const v of values) {
    const option = document.createElement('option');
    option.value = v;
    datalist.appendChild(option);
  }
}

// Repo is forge-qualified ("github:owner/name") rather than bare, since
// the same repo name can exist under more than one forge — picking one
// has to resolve to exactly that forge's copy, never both
// (matchesFilters matches this value exactly, not by substring).
// Grouped under a heading per forge (<optgroup>) only when more than
// one forge is actually represented among items — a single forge has
// nothing left to disambiguate, so options stay flat. Returns true when
// the previously selected repo went stale, the same signal
// populateSelect gives.
export function populateRepoSelect(
  select: HTMLSelectElement | null,
  items: FilterableItem[],
): boolean {
  if (!select) return false;
  const previous = select.value;
  const byForge: Record<string, { value: string; label: string }[]> = {};
  const seen = new Set<string>();

  for (const item of items) {
    const value = `${item.forge}:${item.repo}`;
    byForge[item.forge] ??= [];
    if (!seen.has(value)) {
      seen.add(value);
      byForge[item.forge].push({ value, label: item.repo });
    }
  }
  const forgeOrder = Object.keys(byForge).sort();
  for (const forge of forgeOrder) {
    byForge[forge].sort((a, b) => a.label.localeCompare(b.label));
  }

  // Unlike populateSelect's flat options, a previous population here
  // may have left <optgroup> wrappers behind — select.remove(), like
  // the options collection it acts on, only ever removes <option>
  // elements, never the (possibly now-empty) <optgroup> holding them.
  for (const child of Array.from(select.children).slice(1)) child.remove();

  const grouped = forgeOrder.length > 1;
  let stillPresent = false;
  for (const forge of forgeOrder) {
    let parent: HTMLElement = select;
    if (grouped) {
      const group = document.createElement('optgroup');
      group.label = FORGE_LABELS[forge] || forge;
      select.appendChild(group);
      parent = group;
    }
    for (const entry of byForge[forge]) {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      parent.appendChild(option);
      if (entry.value === previous) stillPresent = true;
    }
  }

  if (stillPresent) {
    select.value = previous;
    return false;
  }
  select.value = '';
  return Boolean(previous);
}
