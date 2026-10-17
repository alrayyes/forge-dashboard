// The first refresh after a restart (#1672). The server holds no state until a
// viewer's first refresh has finished, so the first snapshot is empty and the
// pages would draw their normal empty states. The server says so with
// `firstRefreshDone` on the snapshot; this only turns that answer into what to
// draw. A missing flag counts as loaded, so a server that does not send it
// changes nothing.

// Past this long the status line admits it is slow (NN/g: 10 s is where a user
// expects more than a spinner).
export const FIRST_REFRESH_SLOW_MS = 10_000;

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

// The Branches page reads its list on its own timer, so a first refresh that
// finishes between two reads leaves it showing the empty list until the next
// one. It reads again when the flag turns from false to true. A flag first
// seen as true (a warm load) is not a flip: the list was read after it.
export function firstRefreshJustFinished(
  previous: boolean | null | undefined,
  next: boolean | null | undefined,
): boolean {
  return previous === false && next === true;
}
