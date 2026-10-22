// Shared filter state and matching, used by both the main dashboard and
// Insights — the one place their filter behavior is implemented instead of
// two independently maintained copies.

export interface SharedFilterState {
  shared: Record<string, string>;
  pr: Record<string, string>;
  issue: Record<string, string>;
  // How the pull request list is shown rather than what it's filtered
  // by (#710): sort ('' = last activity, the server's own order) and
  // paused ('1' = hold live updates). Kept apart from shared/pr/issue so
  // "Clear filters" never resets them.
  view: Record<string, string>;
  // The Branches page's status, forge and search (#1620). Optional so a
  // state built without it, or a saved copy from before it existed, still
  // reads as "nothing set".
  branches?: Record<string, string>;
  // The Webhooks page's forge, repo search, status and sort. Optional for
  // the same reason as branches.
  webhooks?: Record<string, string>;
}

export interface FilterableItem {
  forge: string;
  repo: string;
  // The ticket number, matched by the title box.
  number?: number;
  title: string;
  author?: string;
  // The author's avatar on their forge, for the Author filter's choices.
  authorAvatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  ci?: string;
  // Whether auto-merge is scheduled, as the forge says it. Absent when the
  // forge can't say, which is in neither On nor Off (#1455).
  autoMergeEnabled?: boolean;
  draft?: boolean;
  mergeStatus?: string;
  labels?: { name: string }[];
  review?: { decision: string; requestedReviewers: number };
  // True for a bot's housekeeping issue; the server decides (#980).
  housekeeping?: boolean;
  // What sort of pull request this is, from the server (#716).
  kind?: 'release' | 'dependency' | 'regular';
  // The server's own answers for the Ready and Needs Review quick filters
  // (#807): the page holds no copy of what they mean.
  readyToMerge?: boolean;
  needsReview?: boolean;
  // The server's answer for Failing CI (#1946): not failing when the only
  // trouble is a workflow held for approval. Absent from an older server.
  failingCi?: boolean;
  // Whether this open, non-draft pull request asks the signed-in user to
  // review it (#695), worked out by the server against the username saved
  // in Settings for its forge.
  reviewRequestedFromMe?: boolean;
  // The issues a pull request will close, and the pull requests that will
  // close an issue. Only their presence is read here; the server joins them.
  closesIssues?: unknown[];
  linkedPullRequests?: unknown[];
}

// The pull-request-only quick filter pills (#678). Stored as pr.quick.
export const QUICK_FILTERS = [
  'failing',
  'running',
  'passing',
  'no-checks',
  'ready',
  'needs-review',
  'review-requested',
  'conflicting',
] as const;
export type QuickFilter = (typeof QUICK_FILTERS)[number];

// Whether a row shows the Blocked chip. Not while CI is pending (#418: the
// forge reports blocked until checks finish) and not while it is failing
// (#1561: the failing CI pill already says why). It stays for success and no
// CI, where a review or branch protection is what blocks. Display only: the
// quick filters read the server's own answers and are unaffected.
export function showBlockedChip(
  mergeStatus: string | undefined,
  ci: string | undefined,
): boolean {
  return mergeStatus === 'blocked' && ci !== 'pending' && ci !== 'failure';
}

// What Failing means to the filters: the server's own answer where it gives
// one, else the raw CI state of a server that predates it (#1946).
function isFailing(item: FilterableItem): boolean {
  return item.failingCi ?? item.ci === 'failure';
}

// The CI state a count should file a pull request under: the raw state, except
// that one failing only for a workflow held for approval waits on a person and
// counts as running, not failing (#1946).
export function ciBucket(item: FilterableItem): string | undefined {
  return item.ci === 'failure' && !isFailing(item) ? 'pending' : item.ci;
}

export function matchesQuickFilter(
  item: FilterableItem,
  quick: string | undefined,
): boolean {
  switch (quick) {
    case 'failing':
      return isFailing(item);
    case 'running':
      return item.ci === 'pending';
    case 'passing':
      return item.ci === 'success';
    case 'no-checks':
      return item.ci === 'none';
    case 'ready':
      return item.readyToMerge === true;
    case 'needs-review':
      return item.needsReview === true;
    case 'review-requested':
      return item.reviewRequestedFromMe === true;
    case 'conflicting':
      // The field the row's own Conflicting pill reads, so the page holds no
      // rule of its own. A draft that conflicts still needs the conflict
      // fixed, so it is listed too (#1215).
      return item.mergeStatus === 'conflicting';
    default:
      return true;
  }
}

// The auto-merge choice (#1455): On keeps what the forge says is scheduled,
// Off what it says is not. A pull request it didn't say anything about is in
// neither.
export function matchesAutoMerge(
  item: FilterableItem,
  autoMerge: string | undefined,
): boolean {
  if (autoMerge === 'on') return item.autoMergeEnabled === true;
  if (autoMerge === 'off') return item.autoMergeEnabled === false;
  return true;
}

// The closing-link choice: 'yes' keeps a pull request that closes an issue, or
// an issue a pull request closes; 'no' keeps the rest. Nothing sent counts as
// no link.
export function matchesClosing(
  item: FilterableItem,
  isPR: boolean,
  value: string | undefined,
): boolean {
  if (value !== 'yes' && value !== 'no') return true;
  const linked = ((isPR ? item.closesIssues : item.linkedPullRequests) ?? [])
    .length;
  return value === 'yes' ? linked > 0 : linked === 0;
}

// How each closing-link choice reads, on its button and in the active-filter
// chip, so the two cannot drift.
export function closingChoiceLabel(isPR: boolean, value: 'yes' | 'no'): string {
  if (isPR) return value === 'yes' ? 'Closes an issue' : 'Closes no issue';
  return value === 'yes'
    ? 'Has a closing pull request'
    : 'No closing pull request';
}

// The pill that's active for a state: a quick filter wins, then a forge,
// else "all". Exactly one pill is ever active.
export function activePill(state: SharedFilterState): string {
  // A pill saved before it was removed (Bot PRs, #1192) no longer matches
  // anything, so it doesn't count as active either.
  if (
    state.pr.quick &&
    (QUICK_FILTERS as readonly string[]).includes(state.pr.quick)
  )
    return state.pr.quick;
  if (state.shared.forge) return state.shared.forge;
  return 'all';
}

// Activates one pill in place: clears the other pill's effect first, so
// choosing one always deselects the rest. Mutated, not replaced — board
// closures hold these exact objects.
export function setPill(state: SharedFilterState, pill: string): void {
  // Set to '' rather than deleted, so a merge of the server's copy
  // over a stale cookie still clears the old pill.
  state.shared.forge = '';
  state.pr.quick = '';
  if (pill === 'github' || pill === 'forgejo') state.shared.forge = pill;
  else if ((QUICK_FILTERS as readonly string[]).includes(pill))
    state.pr.quick = pill;
}

import { FORGE_LABELS } from './forges';
import {
  carriesAny,
  joinLabels,
  labelKey,
  narrowLabels,
  type PickChoice,
  parseLabels,
  unionLabels,
} from './label-filter';

export { FORGE_LABELS };
// The slice of /api/dashboard's repos[] that a repo group header needs.
export interface RepoRef {
  forge: string;
  fullName: string;
  url: string;
  // The repository's own logo, absent when it has none.
  logoUrl?: string;
  hasWebhook: boolean;
}

export type RepoSyncStatus = 'Webhook' | 'Polling';

// A repo is identified by forge plus full name: the same owner/name can
// exist on both forges.
export function repoKey(forge: string, fullName: string): string {
  return `${forge}:${fullName}`;
}

// The instance host a repo lives on, read from its web URL (#679).
// Forgejo's comes from the forge's own response and GitHub's is always
// github.com, so no API field is needed. Empty when the URL is missing or
// not absolute, so the caller can omit the chip rather than guess.
export function hostFromUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// "Webhook" once a signature-verified delivery has been recorded for the
// repo, "Polling" otherwise: the dashboard's periodic refresh is what keeps
// it current until then. The text carries the meaning, colour only adds to
// it.
export function repoSyncStatus(
  repo: Pick<RepoRef, 'hasWebhook'>,
): RepoSyncStatus {
  return repo.hasWebhook ? 'Webhook' : 'Polling';
}

const FILTERS_COOKIE = 'forge-board-filters';

function getCookie(name: string): string | null {
  const match = document.cookie.match(
    new RegExp(
      `(?:^|; )${name.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`,
    ),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

// A saved state carries a revision, `rev`, in the cookie and in the server
// copy. Every save is one past the newest revision this browser has seen, from
// the cookie, the server copy or its own last save. A counter, not a clock, so
// a device whose clock is ahead cannot make a stale state win. On load the
// copy is applied unless the cookie is strictly newer (see loadStateFromServer).
let knownRev = 0;
// The cookie's revision when this page loaded, to compare with the copy's. An
// edit made while the copy loads raises the cookie's revision, but the copy
// was still requested before it, and the touched keys already protect the edit.
let loadedCookieRev: number | null = null;

function revOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function cookieRev(): number | null {
  const raw = getCookie(FILTERS_COOKIE);
  if (!raw) return null;
  try {
    return revOf(JSON.parse(raw)?.rev);
  } catch {
    return null;
  }
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
    view: {},
    branches: {},
    webhooks: {},
  };
}

export function loadState(): SharedFilterState {
  // A new page starts with nothing edited, and any saved-copy callback of the
  // page before it is now stale.
  pageGeneration++;
  resetTouched();
  loadedCookieRev = cookieRev();
  if (loadedCookieRev !== null) knownRev = Math.max(knownRev, loadedCookieRev);
  return readCookieState();
}

// The state the cookie holds right now, without starting a new page. A page
// that saves later reads it again so it changes only its own keys, not what
// another tab saved in between.
export function readCookieState(): SharedFilterState {
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
  if (parsed.view && typeof parsed.view === 'object')
    Object.assign(state.view, parsed.view);
  if (parsed.branches && typeof parsed.branches === 'object')
    state.branches = { ...state.branches, ...parsed.branches };
  if (parsed.webhooks && typeof parsed.webhooks === 'object')
    state.webhooks = { ...state.webhooks, ...parsed.webhooks };
  dropUnknownAutoMerge(state);
  dropUnknownClosing(state);
  dropNonStringTitleRule(state);
  migrateCiStatus(state);
  trimLabelPick(state);
  return state;
}

// A saved auto-merge choice is only 'on' or 'off'; anything else is a stale
// or hand-edited value, and reads as Any rather than as a chip nothing can
// undo (#1455).
function dropUnknownAutoMerge(state: SharedFilterState): void {
  const value = state.pr.autoMerge;
  if (value !== undefined && value !== 'on' && value !== 'off')
    delete state.pr.autoMerge;
}

// The same for the closing-link choice, which is only 'yes' or 'no'.
function dropUnknownClosing(state: SharedFilterState): void {
  for (const [group, key] of [
    [state.pr, 'closes'],
    [state.issue, 'closedBy'],
  ] as const) {
    const value = group[key];
    if (value !== undefined && value !== 'yes' && value !== 'no')
      delete group[key];
  }
}

// The pull request board used to have a CI status pulldown; the quick pills
// do the same job. A status saved from then becomes the pill it matches, so it
// still filters and can be seen and cleared. A pill or a forge already picked
// stays (the pills are one choice), and the old status is dropped rather than
// left as a filter nothing on the page shows (#2084).
const CI_STATUS_PILLS: Record<string, string> = {
  success: 'passing',
  failure: 'failing',
  pending: 'running',
  none: 'no-checks',
};

// Set when a saved status was read, so the page saves the migrated state once
// and the old key leaves the cookie and the server copy.
let statusMigrated = false;

export function takeMigratedStatus(): boolean {
  const was = statusMigrated;
  statusMigrated = false;
  return was;
}

function migrateCiStatus(state: SharedFilterState): void {
  const status = state.pr.status;
  if (status === undefined) return;
  delete state.pr.status;
  statusMigrated = true;
  const pill = CI_STATUS_PILLS[status];
  // Only a pill that still exists counts as picked: a saved one that was
  // removed since shows as no pill, so it must not block the migration.
  const pickedPill = (QUICK_FILTERS as readonly string[]).includes(
    state.pr.quick ?? '',
  );
  if (!pill || pickedPill || state.shared.forge) return;
  if (isTouched('pr', 'quick') || isTouched('shared', 'forge')) return;
  state.pr.quick = pill;
}

// A saved title pattern is a string; anything else is a stale or hand-edited
// value and reads as no rule (#1593).
function dropNonStringTitleRule(state: SharedFilterState): void {
  if (typeof state.issue.hideTitleRegex !== 'string')
    delete state.issue.hideTitleRegex;
}

// Longest title search kept. The search box stops at this many characters, and
// a longer saved one is cut as the cookie is read.
export const MAX_TITLE = 200;

// A saved Label pick over the limits the server holds it to (a cookie from an
// earlier build, or a hand-edited one) would make every later save a 400 that
// drops the other filters with it. It is cut down to what fits as it is read.
function trimLabelPick(state: SharedFilterState): void {
  // The title search shares the cookie with the picks, so it is capped too.
  if (typeof state.shared.title === 'string')
    state.shared.title = state.shared.title.slice(0, MAX_TITLE);
  // The Repo and Author picks are held to the same limits as the Label's.
  for (const key of ['label', 'repo', 'author']) {
    const pick = state.shared[key];
    if (pick === undefined) continue;
    if (typeof pick !== 'string') delete state.shared[key];
    else state.shared[key] = joinLabels(parseLabels(pick));
  }
}

// A pick the page being shown does not offer (an author who wrote no pull
// request, on the Pull requests page) is cleared there so the list isn't
// emptied by something nothing can match (#112, #1427). That clearing is about
// this page, not about the choice: it is held back from the saved copy, so the
// page that does offer it finds it still set (#1620). The user's own change to
// the same control ends the hold.
type StateGroup = 'shared' | 'pr' | 'issue' | 'view';
const held: { group: StateGroup; key: string; value: string }[] = [];

const PICK_KEYS = ['label', 'repo', 'author'];

function heldValue(group: StateGroup, key: string): string | undefined {
  return held.find((h) => h.group === group && h.key === key)?.value;
}

// Clears the pick in state, as a page that does not offer it needs, and keeps
// its value for the saved copy.
export function holdStale(
  state: SharedFilterState,
  group: StateGroup,
  key: string,
): void {
  const value = state[group][key];
  if (value) {
    releaseHeld(group, key);
    held.push({ group, key, value });
  }
  state[group][key] = '';
}

// The Label filter holds several labels, and the page may offer only some of
// them. The ones it does not offer are set aside (held, when the page is
// reconciling its saved picks; dropped for good after the user's own change)
// and the rest stay picked. True if any were set aside.
export function reconcilePick(
  state: SharedFilterState,
  key: 'label' | 'repo' | 'author',
  offered: string[],
  hold: boolean,
): boolean {
  const { kept, dropped } = narrowLabels(
    parseLabels(state.shared[key]),
    offered,
  );
  if (dropped.length === 0) return false;
  const before = heldValue('shared', key) ?? '';
  releaseHeld('shared', key);
  if (hold)
    held.push({
      group: 'shared',
      key,
      value: unionLabels(before, joinLabels(dropped)),
    });
  state.shared[key] = joinLabels(kept);
  return true;
}

// A repo is saved forge-qualified ("github:acme/api") and read without it.
function repoName(value: string): string {
  return value.slice(value.indexOf(':') + 1);
}

// The user chose something else for this control (or cleared it): the held
// value is no longer wanted.
export function releaseHeld(group: StateGroup, key: string): void {
  const at = held.findIndex((h) => h.group === group && h.key === key);
  if (at >= 0) held.splice(at, 1);
}

export function releaseAllHeld(): void {
  held.length = 0;
}

export type HeldPick = {
  group: StateGroup;
  key: string;
  // What the control is called ("author", "repo").
  name: string;
  // The saved value as a reader knows it ("acme/docs", "< 7 days").
  text: string;
};

// The picks this page cleared for itself but still has saved, so it can say
// so instead of showing an unfiltered list with nothing to explain it (#1620).
export function heldPicks(): HeldPick[] {
  return held.map((h) => {
    let text = h.value;
    if (h.key === 'repo') text = parseLabels(h.value).map(repoName).join(', ');
    if (h.key === 'author') text = parseLabels(h.value).join(', ');
    const choices =
      h.key === 'created' || h.key === 'updated' ? AGE_RANGES : [];
    text = choices.find((c) => c.value === h.value)?.label ?? text;
    if (h.key === 'label') text = parseLabels(h.value).join(', ');
    return { group: h.group, key: h.key, name: h.key, text };
  });
}

const HELD_TEXT_MAX = 40;

// A saved value can be anything a hand-edited copy holds; the page shows the
// start of it. The full value stays in the saved state, never in the markup.
function shortText(text: string): string {
  return text.length > HELD_TEXT_MAX
    ? `${text.slice(0, HELD_TEXT_MAX)}…`
    : text;
}

// How the pick reads in a sentence: a name and value for the text kinds, and
// "filter" with the control's name for the date and CI kinds.
function heldPickPhrase(pick: HeldPick): string {
  const value = shortText(pick.text);
  if (['created', 'updated'].includes(pick.key))
    return `filter "${FILTER_NAMES[pick.key]}: ${value}"`;
  return `${pick.name} "${value}"`;
}

export function heldPickNote(pick: HeldPick): string {
  return `Saved ${heldPickPhrase(pick)} is not on this page.`;
}

export function heldPickClearLabel(pick: HeldPick): string {
  return `Clear saved ${heldPickPhrase(pick)}`;
}

function heldPickId(pick: HeldPick): string {
  return `${pick.group}.${pick.key}`;
}

// Keeps the note's container in step with the held picks, touching only the
// lines that changed so a screen reader isn't handed the others again. The
// container stays in the page (a polite status region), so a change in it is
// heard. Focus after a Clear goes to the next Clear button, or the container.
export function renderHeldPicks(
  container: HTMLElement,
  onRemove: (pick: HeldPick) => void,
): void {
  const picks = heldPicks();
  const lines = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) {
    const line = child as HTMLElement;
    lines.set(line.dataset.pick ?? '', line);
  }
  const wanted = new Set(picks.map(heldPickId));
  for (const [id, line] of lines)
    if (!wanted.has(id)) {
      line.remove();
      lines.delete(id);
    }
  for (const pick of picks) {
    const id = heldPickId(pick);
    const note = heldPickNote(pick);
    const existing = lines.get(id);
    if (existing) {
      const text = existing.querySelector('span');
      if (text && text.textContent !== note) text.textContent = note;
      existing
        .querySelector('button')
        ?.setAttribute('aria-label', heldPickClearLabel(pick));
      continue;
    }
    const line = document.createElement('p');
    line.className = 'held-pick';
    line.dataset.pick = id;
    const text = document.createElement('span');
    text.textContent = note;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'held-pick-clear';
    button.textContent = 'Clear';
    button.setAttribute('aria-label', heldPickClearLabel(pick));
    button.addEventListener('click', () => {
      onRemove(pick);
      focusHeldPicks(container);
    });
    line.append(text, button);
    container.appendChild(line);
  }
}

// A gentle place to land once a Clear button is gone: the next one, or the
// container itself (not a text box, so a phone keeps its keyboard down).
export function focusHeldPicks(container: HTMLElement): void {
  const next = container.querySelector<HTMLElement>('.held-pick-clear');
  (next ?? container).focus();
}

// What gets saved: the state with every held pick put back where the page
// cleared it.
function savedCopy(state: SharedFilterState): SharedFilterState {
  if (held.length === 0) return state;
  const copy: SharedFilterState = {
    shared: { ...state.shared },
    pr: { ...state.pr },
    issue: { ...state.issue },
    view: { ...state.view },
    branches: { ...state.branches },
    webhooks: { ...state.webhooks },
  };
  for (const h of held) {
    if (!copy[h.group][h.key]) copy[h.group][h.key] = h.value;
    // The Label, Repo and Author filters hold several: what this page set
    // aside joins what is picked here.
    else if (h.group === 'shared' && PICK_KEYS.includes(h.key))
      copy.shared[h.key] = unionLabels(copy.shared[h.key], h.value);
  }
  return copy;
}

const FILTER_STATE_ENDPOINT = '/api/settings/filter-state';
// Long enough that a fast typist's keystrokes coalesce into one write,
// short enough that a real pause reads as "done typing," matching the
// "debounce free text, not discrete controls" split #353 asks for —
// see saveState's own comment for which callers hit which path.
const TITLE_SAVE_DEBOUNCE_MS = 500;
let titleSaveTimer: ReturnType<typeof setTimeout> | null = null;
// The snapshot the timer will send. Kept so a flush on leaving the page can
// send it without waiting for the timer (#1620).
let titleSaveState: SharedFilterState | null = null;

// One PUT at a time. The server keeps whichever request lands last, and two
// in flight can land in either order, so a pick made right after another
// could be overwritten by the older one (#1637). While a PUT is out, newer
// saves only replace the snapshot waiting behind it; the body is built when
// it is sent, so the last pick is always the last one the server gets.
// A request that never settles would hold the queue shut for the rest of the
// page load, so each PUT is aborted after this long and releases it through
// the failure path. Ten seconds is well past a healthy save on a slow link and
// short enough that the next pick still reaches the server in the same visit.
const PUT_TIMEOUT_MS = 10_000;
let putInFlight = false;
let queuedState: SharedFilterState | null = null;

const REFUSED_NOTICE_ID = 'filter-save-refused';
const REFUSED_TEXT =
  "Your filters were not saved on the server, so another device won't see them.";

function showRefusedNotice(): void {
  if (typeof document?.getElementById !== 'function') return;
  if (document.getElementById(REFUSED_NOTICE_ID)) return;
  const note = document.createElement('p');
  note.id = REFUSED_NOTICE_ID;
  note.className = 'error-banner';
  note.setAttribute('role', 'alert');
  note.textContent = REFUSED_TEXT;
  const bar = document.querySelector('.filter-bar');
  if (bar?.parentElement) bar.parentElement.insertBefore(note, bar);
  else document.body?.prepend(note);
}

function clearRefusedNotice(): void {
  if (typeof document?.getElementById !== 'function') return;
  document.getElementById(REFUSED_NOTICE_ID)?.remove();
}

let refusedHandler: () => void = showRefusedNotice;

// For tests: what happens when the server refuses a save. Null puts the
// notice back.
export function setSaveRefusedHandler(handler: (() => void) | null): void {
  refusedHandler = handler ?? showRefusedNotice;
}

function putFilterStateToServer(state: SharedFilterState): void {
  if (putInFlight) {
    queuedState = state;
    return;
  }
  sendFilterState(state);
}

function sendFilterState(state: SharedFilterState): void {
  const alone = !putInFlight;
  putInFlight = true;
  // keepalive lets the request outlive the page: the dashboard and issues
  // pages share this state, and a click on the other page's nav item right
  // after a change would otherwise cancel the save (#827).
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PUT_TIMEOUT_MS);
  void fetch(FILTER_STATE_ENDPOINT, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...savedCopy(state), rev: knownRev }),
    keepalive: true,
    signal: abort.signal,
  })
    .then((res) => {
      // A save the server turns away is not sent again (the same body would
      // get the same answer); the reader is told instead of left to find the
      // filter gone on another device.
      if (!res.ok) refusedHandler();
      else clearRefusedNotice();
    })
    .catch(() => {
      // Best-effort, the same restraint RecordWebhookDelivery's own
      // server-side "a failure to persist this doesn't fail the request
      // it's riding along with" gets — the cookie already has this
      // value locally regardless, so a lost sync here just means the
      // next device to load stays on its own last-synced state instead
      // of today's, not a broken filter bar.
    })
    .then(() => {
      clearTimeout(timer);
      // A flush can send beside a PUT in flight; only the one that took the
      // slot gives it back, or the queue would open early.
      if (alone) putInFlight = false;
      else return;
      const next = queuedState;
      queuedState = null;
      if (next) putFilterStateToServer(next);
    });
}

// Sends the save still waiting on the debounce timer, or queued behind a PUT
// in flight, right now. Called when the page is going away (pagehide, or the
// tab turning hidden): a timer or a queue does not survive that, and the server
// copy would lose a value typed in the last 500 ms (#1620). The cookie needs no
// flush, saveState writes it on every call, so the next load has the latest
// value even if this request is lost. A PUT already in flight is not waited
// for: the snapshot goes out beside it with keepalive, and stays queued so the
// newest value is sent again after it if the page lives on.
export function flushPendingSave(): void {
  const next = titleSaveState ?? queuedState;
  if (titleSaveTimer) clearTimeout(titleSaveTimer);
  titleSaveTimer = null;
  titleSaveState = null;
  queuedState = null;
  if (!next) return;
  // Beside a PUT in flight, keep the snapshot queued as well. The request just
  // sent can land before the older one, which would then leave the old value on
  // the server; the completion path re-sends the newest after it. One duplicate
  // PUT, and only when the page survives (a tab switch, not an unload).
  if (putInFlight) queuedState = next;
  sendFilterState(next);
}

let leaveListenersAdded = false;
function listenForLeaving(): void {
  if (leaveListenersAdded) return;
  if (typeof addEventListener !== 'function') return;
  if (typeof document?.addEventListener !== 'function') return;
  leaveListenersAdded = true;
  // pagehide and visibilitychange are the events that fire reliably on
  // leaving, on mobile too; unload and beforeunload do not (MDN).
  addEventListener('pagehide', flushPendingSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSave();
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
  // Another tab may have saved since: go one past the newest revision known.
  knownRev = Math.max(knownRev, cookieRev() ?? 0) + 1;
  try {
    setCookie(
      FILTERS_COOKIE,
      JSON.stringify({ ...savedCopy(state), rev: knownRev }),
    );
  } catch {
    /* ignore */
  }

  listenForLeaving();
  if (debouncedCol === 'title' || debouncedCol === 'hideTitleRegex') {
    if (titleSaveTimer) clearTimeout(titleSaveTimer);
    titleSaveState = state;
    titleSaveTimer = setTimeout(() => {
      titleSaveTimer = null;
      titleSaveState = null;
      putFilterStateToServer(state);
    }, TITLE_SAVE_DEBOUNCE_MS);
    return;
  }
  if (titleSaveTimer) {
    clearTimeout(titleSaveTimer);
    titleSaveTimer = null;
    titleSaveState = null;
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
        (!parsed.issue || Object.keys(parsed.issue).length === 0) &&
        (!parsed.view || Object.keys(parsed.view).length === 0) &&
        (!parsed.branches || Object.keys(parsed.branches).length === 0) &&
        (!parsed.webhooks || Object.keys(parsed.webhooks).length === 0)
      ) {
        return null;
      }
      const copyRev = revOf((parsed as { rev?: unknown }).rev);
      if (copyRev !== null) knownRev = Math.max(knownRev, copyRev);
      // The cookie holds a newer save than the copy: the copy is what a slow or
      // lost save left behind, so it must not overwrite the cookie. Send the
      // cookie's state so the server catches up. A missing or equal revision on
      // either side keeps the copy winning, as it did before revisions.
      if (
        copyRev !== null &&
        loadedCookieRev !== null &&
        loadedCookieRev > copyRev
      ) {
        putFilterStateToServer(readCookieState());
        return null;
      }
      return parsed;
    })
    .catch(() => null);
}

// The filter keys the user has changed since this page loaded (#1713). The
// saved copy is fetched a moment after the cookie is read; an edit made while
// it is in flight is newer than the copy, so the copy must not overwrite it.
// Keys are "group.key". Clear filters touches every key of the three filter
// groups at once, so a late copy cannot bring old values back.
type TouchGroup = StateGroup | 'branches' | 'webhooks';
const touchedKeys = new Set<string>();
let clearedAll = false;
const CLEARED_GROUPS: TouchGroup[] = ['shared', 'pr', 'issue'];

// Which page the touched keys belong to. loadState starts a new one and
// leavePage ends the current one. A saved-copy callback captures it when it
// asks and drops its answer if it changed: the touched keys and filter state
// it would merge into are another page's by then, and saving from it would
// write its old state over that page's edits.
let pageGeneration = 0;

export function currentPage(): number {
  return pageGeneration;
}

// Only ends the page it is given: if the next page has already loaded, its
// state is not touched.
export function leavePage(page: number): void {
  if (page !== pageGeneration) return;
  pageGeneration++;
  resetTouched();
}

// Contract: every code path where the user changes a filter, view or sort
// control must call this for the key it changes, before saving. Without it a
// copy that is still loading overwrites the change. Page-driven changes (a pick
// the page can't offer being cleared) must not call it, or the copy would no
// longer be applied to a key the user never touched. A new page that edits
// the shared state, such as one for branches, has to follow the same rule.
export function touchKey(group: TouchGroup, key: string): void {
  touchedKeys.add(`${group}.${key}`);
}

export function touchAll(): void {
  clearedAll = true;
}

export function resetTouched(): void {
  touchedKeys.clear();
  clearedAll = false;
}

export function hasTouched(): boolean {
  return clearedAll || touchedKeys.size > 0;
}

function isTouched(group: TouchGroup, key: string): boolean {
  return (
    (clearedAll && CLEARED_GROUPS.includes(group)) ||
    touchedKeys.has(`${group}.${key}`)
  );
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
  for (const group of ['shared', 'pr', 'issue', 'view'] as const) {
    const incoming = got[group];
    if (!incoming || typeof incoming !== 'object') continue;
    for (const [key, value] of Object.entries(incoming)) {
      // The user changed this since the page loaded: their value is newer
      // than the copy, which was requested before the edit (#1713).
      if (isTouched(group, key)) continue;
      // The server holds the pick this page cleared for itself: it agrees
      // with what is held, so it stays cleared here. A different value is
      // another device's newer choice and wins.
      if (heldValue(group, key) === value) continue;
      releaseHeld(group, key);
      state[group][key] = value;
    }
  }
  // Branches and Webhooks have no held picks: their controls keep the active
  // choice on offer.
  for (const group of ['branches', 'webhooks'] as const) {
    const incoming = got[group];
    if (!incoming || typeof incoming !== 'object') continue;
    state[group] ??= {};
    const into = state[group];
    for (const [key, value] of Object.entries(incoming))
      if (!isTouched(group, key)) into[key] = value;
  }
  dropUnknownAutoMerge(state);
  dropUnknownClosing(state);
  dropNonStringTitleRule(state);
  migrateCiStatus(state);
  trimLabelPick(state);
}

export function minutesAgo(iso: string): number {
  return Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60000),
  );
}

// The title box also takes a ticket number: `1884` or `#1884` matches numbers
// that start with it. The # is optional and does not change what matches, so a
// year or a version in a title stays findable and a title that holds `#1884`
// as typed does too. Issues, pull requests and Bot PRs all match this way.
export function matchesTitleTerm(item: FilterableItem, term: string): boolean {
  const inTitle = item.title.toLowerCase().includes(term);
  if (item.number === undefined) return inTitle;
  const digits = /^#?(\d+)$/.exec(term.trim());
  if (!digits) return inTitle;
  return String(item.number).startsWith(digits[1]) || inTitle;
}

// shared carries the fields that apply to both pull requests and
// issues; extra carries whichever board-owned field applies to this
// item's own entity type (quick and autoMerge for a pull request,
// hideDependencyDashboard for an issue) — the caller passes only the
// one relevant to isPR.
export function matchesFilters(
  item: FilterableItem,
  isPR: boolean,
  shared: Record<string, string>,
  extra: Record<string, string> | undefined,
): boolean {
  return failingFilters(item, isPR, shared, extra).length === 0;
}

// Which active filters exclude an item, by the key each is stored under
// (shared.repo, pr.quick, ...). Empty when it matches. Show row
// (#723) uses it to say what hides a row and to clear exactly those.
export function failingFilters(
  item: FilterableItem,
  isPR: boolean,
  shared: Record<string, string>,
  extra: Record<string, string> | undefined,
): string[] {
  const repoKey = `${item.forge}:${item.repo}`.toLowerCase();
  const failing: string[] = [];
  if (shared.forge && item.forge !== shared.forge) failing.push('forge');
  if (!pickedHas(shared.repo, repoKey)) failing.push('repo');
  if (shared.title && !matchesTitleTerm(item, shared.title))
    failing.push('title');
  if (!pickedHas(shared.author, item.author || '')) failing.push('author');
  if (shared.created && minutesAgo(item.createdAt) > Number(shared.created))
    failing.push('created');
  if (shared.updated && minutesAgo(item.updatedAt) > Number(shared.updated))
    failing.push('updated');
  // Any of the picked labels (shared.label holds one or several).
  if (!carriesAny(item.labels, shared.label)) failing.push('label');
  if (isPR && !matchesQuickFilter(item, extra?.quick)) failing.push('quick');
  if (isPR && !matchesAutoMerge(item, extra?.autoMerge))
    failing.push('autoMerge');
  if (isPR && !matchesClosing(item, true, extra?.closes))
    failing.push('closes');
  if (!isPR && !matchesClosing(item, false, extra?.closedBy))
    failing.push('closedBy');
  // A bot's housekeeping issue (Renovate's Dependency Dashboard): the
  // server says which ones those are (#980), so this only reads the flag.
  if (!isPR && extra?.hideDependencyDashboard && item.housekeeping)
    failing.push('hideDependencyDashboard');
  // The user's own hide rule on the Issues page (#1593).
  if (!isPR && titleRuleHides(extra?.hideTitleRegex, item.title))
    failing.push('hideTitleRegex');
  return failing;
}

// ---- "Hide titles matching (regex)" on the Issues page (#1593) ----
//
// JavaScript regular expressions have no timeout and cannot be interrupted, so
// a pattern like (a+)+$ can freeze the tab on a title that almost matches. A
// Worker would make the synchronous filter pipeline async, so the page bounds
// the work instead. This is a measured heuristic, not a proof:
//  1. The pattern is at most MAX_TITLE_REGEX_LENGTH characters.
//  2. pathCost() estimates how many ways the engine can try to match the
//     pattern, as a product over its choice points: an alternation adds its
//     branches, a quantifier on an atom or group with cost c allows
//     c^min + ... + c^max ways (a plain atom counts one way per repeat count),
//     and a sequence multiplies. N overlapping choice points are exponential
//     in N, and so is the product. A pattern whose cost passes MAX_COST is
//     refused.
//  3. Only the first MAX_TITLE_TESTED characters of a title are tested.
//  4. Each distinct title is matched once per pattern.
// The fuzz test in title-rule.test.ts checks that whatever this accepts
// finishes without blowing up on hostile 128 and 256 character titles.
export const MAX_TITLE_REGEX_LENGTH = 200;
export const MAX_TITLE_TESTED = 128;
// Calibrated with the fuzz test: at 2048 the slowest accepted pattern out of
// 250,000 random ones took under 20 ms; at 16384 some took over 80 ms.
const MAX_COST = 2048;
const OVER_COST = MAX_COST + 1;
const MAX_PATTERN_DEPTH = 8;
// An open-ended repeat: 0 to this many, so a plain atom has MAX_TITLE_TESTED ways.
const OPEN_REPEAT = MAX_TITLE_TESTED - 1;

// invalid: the engine can't parse it. complex: it parses, but the guard won't
// run it.
export type TitleRule =
  | { status: 'none' }
  | { status: 'invalid' }
  | { status: 'complex' }
  | { status: 'ok'; regex: RegExp; seen: Map<string, boolean> };

const QUANTIFIER = /^(?:[*+?]|\{(\d+)(,(\d*))?\})\??/;
// The text after "(" that is not a capture: (?: (?= (?! (?<= (?<! (?<name>
const GROUP_PREFIX = /^\?(?:[:=!]|<[=!]|<[^>]*>)/;

const times = (a: number, b: number) => Math.min(OVER_COST, a * b);

// Ways to repeat something that has `inner` ways of matching, min to max times.
function repeatCost(inner: number, min: number, max: number): number {
  const top = Math.min(max, OPEN_REPEAT);
  if (inner <= 1) return Math.max(1, top - min + 1);
  let total = 0;
  let power = 1;
  for (let k = 1; k <= top && power < OVER_COST; k++) {
    power = times(power, inner);
    if (k >= min) total = Math.min(OVER_COST, total + power);
  }
  if (min === 0) total = Math.min(OVER_COST, total + 1);
  return power >= OVER_COST ? OVER_COST : total;
}

// Estimated ways to match `pattern` from index `start`, up to the closing
// bracket of the current group; `end` is where it stopped.
function pathCost(pattern: string): number {
  let i = 0;

  function alternation(depth: number): number {
    if (depth > MAX_PATTERN_DEPTH) return OVER_COST;
    let total = 0;
    let branch = 1;
    while (i < pattern.length && pattern[i] !== ')') {
      if (pattern[i] === '|') {
        total = Math.min(OVER_COST, total + branch);
        branch = 1;
        i++;
        continue;
      }
      branch = times(branch, term(depth));
    }
    return Math.min(OVER_COST, total + branch);
  }

  function atom(depth: number): number {
    const c = pattern[i];
    if (c === '(') {
      i++;
      const prefix = GROUP_PREFIX.exec(pattern.slice(i));
      if (prefix) i += prefix[0].length;
      const inner = alternation(depth + 1);
      i++; // the ")"
      return inner;
    }
    if (c === '[') {
      i++;
      while (i < pattern.length && pattern[i] !== ']')
        i += pattern[i] === '\\' ? 2 : 1;
      i++;
      return 1;
    }
    if (c === '\\') {
      // A back reference may re-match what a repeat matched.
      const backReference = /[1-9k]/.test(pattern[i + 1] ?? '');
      i += 2;
      return backReference ? MAX_TITLE_TESTED : 1;
    }
    i++;
    return 1;
  }

  function term(depth: number): number {
    const inner = atom(depth);
    const q = QUANTIFIER.exec(pattern.slice(i));
    if (!q) return inner;
    i += q[0].length;
    const first = q[0][0];
    if (first === '*') return repeatCost(inner, 0, OPEN_REPEAT);
    if (first === '+') return repeatCost(inner, 1, OPEN_REPEAT);
    if (first === '?') return repeatCost(inner, 0, 1);
    const min = Number(q[1]);
    const max =
      q[2] === undefined ? min : q[3] === '' ? OPEN_REPEAT : Number(q[3]);
    return repeatCost(inner, min, max);
  }

  return alternation(0);
}

function isTooComplex(pattern: string): boolean {
  return pathCost(pattern) > MAX_COST;
}

// Compiled once per pattern text: typing and every re-render ask the same
// question, and a bad pattern is judged once.
const titleRuleCache = new Map<string, TitleRule>();

export function compileTitleRule(pattern: unknown): TitleRule {
  if (typeof pattern !== 'string' || pattern === '') return { status: 'none' };
  const cached = titleRuleCache.get(pattern);
  if (cached) return cached;
  let rule: TitleRule = { status: 'invalid' };
  try {
    const regex = new RegExp(pattern, 'i');
    rule =
      pattern.length > MAX_TITLE_REGEX_LENGTH || isTooComplex(pattern)
        ? { status: 'complex' }
        : { status: 'ok', regex, seen: new Map() };
  } catch {
    // The engine's message stays out of the page.
  }
  if (titleRuleCache.size > 50) titleRuleCache.clear();
  titleRuleCache.set(pattern, rule);
  return rule;
}

function titleRuleHides(pattern: unknown, title: string): boolean {
  const rule = compileTitleRule(pattern);
  if (rule.status !== 'ok') return false;
  // Every render asks again for every issue; each distinct title is matched
  // once per pattern.
  let hidden = rule.seen.get(title);
  if (hidden === undefined) {
    if (rule.seen.size > 5000) rule.seen.clear();
    hidden = rule.regex.test(title.slice(0, MAX_TITLE_TESTED));
    rule.seen.set(title, hidden);
  }
  return hidden;
}

// The items a filter's own choices are built from (#1427): what the page can
// show, so a choice never leads to an empty list. That is the page's items
// that every shared filter except excludeKey lets through (leaving the
// filter's own selection out, or a picked value would hide its siblings), and
// that the page's own default hiding lets through too. extra is that
// hiding: hideDependencyDashboard on the Issues page, so a repo whose only
// issue is Renovate's Dependency Dashboard isn't offered while it's hidden.
export type PoolKey =
  | ''
  | 'repo'
  | 'author'
  | 'label'
  | 'forge'
  | 'created'
  | 'updated';

export function optionPool(
  items: FilterableItem[],
  isPR: boolean,
  shared: Record<string, string>,
  excludeKey: PoolKey,
  extra?: Record<string, string>,
): FilterableItem[] {
  const scoped = { ...shared };
  if (excludeKey) scoped[excludeKey] = '';
  return items.filter((item) => matchesFilters(item, isPR, scoped, extra));
}

// What a filter key is called on the page.
export const FILTER_NAMES: Record<string, string> = {
  forge: 'Forge',
  repo: 'Repo',
  title: 'Title',
  author: 'Author',
  created: 'Created',
  updated: 'Updated',
  label: 'Label',
  quick: 'quick',
  autoMerge: 'Auto-merge',
  closes: 'Closing issue',
  closedBy: 'Closing pull request',
  hideTitleRegex: 'Hide titles matching',
};

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

export interface Choice {
  value: string;
  label: string;
}

// populateSelect for options whose label isn't their value (the
// age ranges). Same contract: true when previous was stale and got cleared.
export function populateChoices(
  select: HTMLSelectElement | null,
  choices: Choice[],
  previous: string,
): boolean {
  if (!select) return false;
  while (select.options.length > 1) select.remove(1);
  for (const c of choices) {
    const option = document.createElement('option');
    option.value = c.value;
    option.textContent = c.label;
    select.appendChild(option);
  }
  // Saved picks are lowercase (the filter compares lowercase) while the page
  // offers "Ryan" or "Bug" as written, so the pick is found without regard to
  // case and the option keeps its own text (#1620). An exact match wins.
  const lower = (previous || '').toLowerCase();
  const found =
    choices.find((c) => c.value === previous) ??
    choices.find((c) => c.value.toLowerCase() === lower);
  if (found) {
    select.value = found.value;
    return false;
  }
  select.value = '';
  return Boolean(previous);
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
  return populateChoices(
    select,
    values.map((v) => ({ value: v, label: v })),
    previous,
  );
}

const AGE_RANGES: Choice[] = [
  { value: '60', label: '< 1 hour' },
  { value: '1440', label: '< 24 hours' },
  { value: '10080', label: '< 7 days' },
  { value: '43200', label: '< 30 days' },
];

// The Created or Updated ranges some item falls in (#1427). A range counts
// minutes the way matchesFilters does, so at the same instant an offered range
// always matches. Between two snapshots an item can age out of a range it
// was counted in (minutesAgo rounds to the minute); the next snapshot clears
// it. An invalid date gives NaN, which no range counts.
export function ageChoices(
  items: FilterableItem[],
  field: 'createdAt' | 'updatedAt',
): Choice[] {
  return AGE_RANGES.filter((r) =>
    items.some((i) => minutesAgo(i[field]) <= Number(r.value)),
  );
}

// Shows a forge button only when some result is on that forge, or it is the
// one picked, so it can be seen and cleared (#1427). "All" always stays. The
// pick comes from the saved filter state, not from which radio is checked:
// on a page load the radios are restored after the choices are built.
export function offerForges(
  scope: ParentNode,
  present: Set<string>,
  picked: string,
): void {
  for (const input of scope.querySelectorAll<HTMLInputElement>(
    'input[type="radio"][data-col="forge"]',
  )) {
    const label = input.closest('label');
    if (!label || !input.value) continue;
    label.hidden = !(present.has(input.value) || input.value === picked);
  }
}

// Shows a quick pill only when clicking it would show something, or it is the
// active one, so it can be seen and cleared (#1427). A forge pill matches the
// items on that forge, any other pill its own rule. "All" always stays.
// Choosing a forge clears the repo, author, label and age picks it leaves
// nothing for, so the forge pills count the items those picks would not hide
// (forgePool); a quick pill keeps them, so it counts what they leave
// (quickPool). Both leave out the pills themselves, since choosing one
// replaces the one that was active.
export function offerPills(
  pills: Iterable<HTMLElement>,
  forgePool: FilterableItem[],
  quickPool: FilterableItem[],
  active: string,
): void {
  for (const button of pills) {
    const pill = button.dataset.pill ?? '';
    if (!pill || pill === 'all') continue;
    // The bar and the Filters sheet each have a copy, and only the bar's
    // forge pills carry a class, so a pill is a quick one when it names one
    // of the quick filters and a forge one otherwise.
    const matches = (QUICK_FILTERS as readonly string[]).includes(pill)
      ? quickPool.some((item) => matchesQuickFilter(item, pill))
      : forgePool.some((item) => item.forge === pill);
    button.hidden = !(matches || pill === active);
  }
}

// Which page's closing-link pick counts: a pull request's `closes` or an
// issue's `closedBy`. One place, so the segment and Clear filters agree.
export function closingKey(pullsView: boolean): 'closes' | 'closedBy' {
  return pullsView ? 'closes' : 'closedBy';
}

export function closingGroup(
  state: SharedFilterState,
  pullsView: boolean,
): Record<string, string> {
  return pullsView ? state.pr : state.issue;
}

// True once nothing this page offers differs from the defaults: shared is
// empty, no quick pill, no title pattern, and hideDependencyDashboard is back
// at its default-checked '1'. The closing pick counts only on its own page.
export function filtersAreDefault(
  state: SharedFilterState,
  page: {
    pullsView: boolean;
    settingsHideDependencyDashboard: boolean;
    settingsIgnoreTitles: boolean;
  },
): boolean {
  return (
    Object.keys(state.shared).every((k) => !state.shared[k]) &&
    !state.pr.quick &&
    !state.pr.autoMerge &&
    !closingGroup(state, page.pullsView)[closingKey(page.pullsView)] &&
    // A saved pick this page does not offer is still a filter (#1620).
    heldPicks().length === 0 &&
    // A field the Settings page replaced is not drawn, so what the page saved
    // in it is not something to clear (#1630).
    (page.settingsHideDependencyDashboard ||
      state.issue.hideDependencyDashboard === '1') &&
    (page.settingsIgnoreTitles || !state.issue.hideTitleRegex)
  );
}

// Shows a segmented control's choices only when something in the pool is that
// way, or it is the one picked, and the whole segment only when something is on
// offer. "Any" is always there while the segment is. `attr` names the data
// attribute on its buttons; `available` says which choices the pool backs.
function offerSegment(
  groups: Iterable<HTMLElement>,
  attr: string,
  available: Record<string, boolean>,
  picked: string,
): void {
  for (const group of groups) {
    let allHidden = true;
    for (const [value, backed] of Object.entries(available)) {
      const button = group.querySelector<HTMLElement>(
        `[data-${attr}="${value}"]`,
      );
      if (!button) continue;
      button.hidden = !(backed || picked === value);
      allHidden &&= button.hidden;
    }
    group.hidden = allHidden;
  }
}

// The auto-merge segment's On and Off (#1455).
export function offerAutoMerge(
  groups: Iterable<HTMLElement>,
  pool: FilterableItem[],
  picked: string,
): void {
  offerSegment(
    groups,
    'am',
    {
      on: pool.some((i) => i.autoMergeEnabled === true),
      off: pool.some((i) => i.autoMergeEnabled === false),
    },
    picked,
  );
}

// The closing-link segment's Yes and No.
export function offerClosing(
  groups: Iterable<HTMLElement>,
  pool: FilterableItem[],
  isPR: boolean,
  picked: string,
): void {
  offerSegment(
    groups,
    'link',
    {
      yes: pool.some((i) => matchesClosing(i, isPR, 'yes')),
      no: pool.some((i) => matchesClosing(i, isPR, 'no')),
    },
    picked,
  );
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

// Does the item's value (a repo key, an author) match any of the picked ones?
// Nothing picked lets it through.
function pickedHas(saved: string | undefined, value: string): boolean {
  const picked = parseLabels(saved);
  return picked.length === 0 || picked.includes(labelKey(value));
}

// What the Repo filter offers: forge-qualified so one name on two forges is
// two choices, listed under the forge's name only when several forges show,
// each with its logo when it has one.
export function repoChoices(
  items: FilterableItem[],
  logoFor: (repoKey: string) => string | undefined,
): PickChoice[] {
  const forges = new Set(items.map((i) => i.forge));
  const grouped = forges.size > 1;
  const seen = new Set<string>();
  const out: (PickChoice & { forge: string })[] = [];
  for (const item of items) {
    const value = `${item.forge}:${item.repo}`;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({
      forge: item.forge,
      value,
      text: item.repo,
      group: grouped ? FORGE_LABELS[item.forge] || item.forge : undefined,
      imageUrl: logoFor(value.toLowerCase()) ?? logoFor(value),
      imageKind: 'logo',
    });
  }
  return out.sort(
    (a, b) => a.forge.localeCompare(b.forge) || a.text.localeCompare(b.text),
  );
}

// What the Author filter offers: each login once, with the first avatar seen.
export function authorChoices(items: FilterableItem[]): PickChoice[] {
  const byKey = new Map<string, PickChoice>();
  for (const item of items) {
    if (!item.author) continue;
    const key = item.author.toLowerCase();
    const have = byKey.get(key);
    if (!have)
      byKey.set(key, {
        value: key,
        text: item.author,
        imageUrl: item.authorAvatarUrl || undefined,
        imageKind: 'avatar',
      });
    else if (!have.imageUrl && item.authorAvatarUrl)
      have.imageUrl = item.authorAvatarUrl;
  }
  return [...byKey.values()].sort((a, b) => a.value.localeCompare(b.value));
}

// ---- stable rows (#710) ----

export const SORT_OPTIONS = ['', 'created', 'repo'] as const;

interface SortableItem {
  forge: string;
  repo: string;
  number: number;
  createdAt: string;
}

// '' (Last activity) keeps the order the server sent, which already is
// updatedAt descending. The other two sort on fields that don't change
// when someone comments, so a row only moves when the sort does.
export function sortItems<T extends SortableItem>(
  items: T[],
  sort: string | undefined,
): T[] {
  if (sort === 'created')
    return [...items].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  if (sort === 'repo')
    return [...items].sort(
      (a, b) =>
        a.repo.localeCompare(b.repo) ||
        a.forge.localeCompare(b.forge) ||
        a.number - b.number,
    );
  return items;
}

export function itemKey(item: {
  forge: string;
  repo: string;
  number: number;
}): string {
  return `${item.forge}:${item.repo}#${item.number}`;
}

export interface ListDiff {
  added: number;
  removed: number;
  moved: number;
  // Keys of rows present on both sides whose own content differs.
  changed: string[];
}

// Rows that aren't part of the longest run still in the same relative
// order are the ones that moved: one PR jumping to the top counts once,
// not as everything it jumped over.
function movedCount(shown: string[], latest: string[]): number {
  const index = new Map(latest.map((key, i) => [key, i]));
  const sequence = shown
    .map((key) => index.get(key))
    .filter((i): i is number => i !== undefined);
  const best: number[] = [];
  let longest = 0;
  for (let i = 0; i < sequence.length; i++) {
    best[i] = 1;
    for (let j = 0; j < i; j++)
      if (sequence[j] < sequence[i]) best[i] = Math.max(best[i], best[j] + 1);
    longest = Math.max(longest, best[i]);
  }
  return sequence.length - longest;
}

// updatedAt is left out of "changed": it moves on every touch, and the
// row's own relative-time text is refreshed along with any real change.
function contentSignature(item: object): string {
  const { updatedAt: _ignored, ...rest } = item as Record<string, unknown>;
  return JSON.stringify(rest);
}

export function diffItems<T extends SortableItem>(
  shown: T[],
  latest: T[],
): ListDiff {
  const shownKeys = shown.map(itemKey);
  const latestByKey = new Map(latest.map((item) => [itemKey(item), item]));
  const shownSet = new Set(shownKeys);
  const changed: string[] = [];
  for (const item of shown) {
    const next = latestByKey.get(itemKey(item));
    if (next && contentSignature(next) !== contentSignature(item))
      changed.push(itemKey(item));
  }
  return {
    added: latest.filter((item) => !shownSet.has(itemKey(item))).length,
    removed: shownKeys.filter((key) => !latestByKey.has(key)).length,
    moved: movedCount(shownKeys, latest.map(itemKey)),
    changed,
  };
}
