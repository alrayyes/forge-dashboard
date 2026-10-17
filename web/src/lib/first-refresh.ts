// The first refresh after a restart (#1672). The server holds no state until a
// viewer's first refresh has finished, so the first snapshot is empty and the
// pages would draw their normal empty states. The server says so with
// `firstRefreshDone` on the snapshot; this only turns that answer into what to
// draw. A missing flag counts as loaded, so a server that does not send it
// changes nothing.

// Past this long the status line admits it is slow (NN/g: 10 s is where a user
// expects more than a spinner).
export const FIRST_REFRESH_SLOW_MS = 10_000;

// Until the first dashboard answer arrives the page cannot know the flag, and
// the server may hold that answer for 15 s on a cold start. So after this short
// wait with no answer the page counts as loading. A warm server answers well
// inside it and the page never shows a skeleton it would take away again. NN/g:
// up to 0.1 s feels instant and past 1 s the user needs feedback; 200 ms sits
// between, long enough to spare a warm load and short enough to feel prompt.
export const FIRST_REFRESH_SHOW_DELAY_MS = 200;

export type FirstRefreshState = {
  // The latest flag a snapshot carried; undefined when none did.
  done: boolean | undefined;
  // A snapshot request has answered or failed.
  settled: boolean;
  // The show delay has run out.
  waited: boolean;
};

// Whether the lists, the nav pills and the status line draw their loading
// state. Before any answer: only once the delay has run out. After an answer:
// by its flag (a missing one counts as loaded). After a failure: never, so the
// skeleton cannot hang.
export function firstRefreshLoading(state: FirstRefreshState): boolean {
  if (!state.settled) return state.waited;
  return firstRefreshPending(state.done);
}

// Go's zero time, which a snapshot carries before the first refresh has
// produced anything, is not a moment to show.
export function hasTimestamp(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && new Date(t).getUTCFullYear() > 1;
}

export function firstRefreshPending(done: boolean | null | undefined): boolean {
  return done === false;
}

export function firstRefreshStatus(
  pending: boolean,
  elapsedMs: number,
): string {
  if (!pending) return '';
  return elapsedMs >= FIRST_REFRESH_SLOW_MS
    ? 'Still loading. The first refresh can take a while after a restart.'
    : 'Loading your repositories…';
}

// Branches reads its list from its own endpoint and the flag from the layout's
// snapshot request, which lands later. Until that request has settled, an empty
// list may only mean the flag has not arrived, so say "loading", not "nothing".
export function branchesAwaitingFlag(settled: boolean, total: number): boolean {
  return !settled && total === 0;
}
