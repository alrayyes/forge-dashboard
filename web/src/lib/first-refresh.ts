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
