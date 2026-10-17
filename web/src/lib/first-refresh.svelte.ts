import { FIRST_REFRESH_SHOW_DELAY_MS } from './first-refresh.js';

// The latest `firstRefreshDone` any snapshot carried, shared by the dashboard
// views, the layout's nav pills and the Branches page (#1672). `done` is
// undefined until a snapshot has answered, and undefined again when the server
// sends none. `settled` says a snapshot request has finished one way or the
// other, so a page that waits for the flag cannot wait forever on a failure.
//
// `waited` says the show delay ran out with no answer yet, and `startedAt` is
// when the page started waiting: the "still loading" text counts from there,
// not from when the skeleton appeared.
export const firstRefresh = $state<{
  done: boolean | undefined;
  settled: boolean;
  waited: boolean;
  startedAt: number | undefined;
}>({ done: undefined, settled: false, waited: false, startedAt: undefined });

// Called once when the page mounts. Starts the clock and, if no answer has
// come when the delay is out, lets the pages draw their loading state. Returns
// the cleanup.
export function startFirstRefreshWait(): () => void {
  if (firstRefresh.startedAt === undefined) firstRefresh.startedAt = Date.now();
  const timer = setTimeout(() => {
    firstRefresh.waited = true;
  }, FIRST_REFRESH_SHOW_DELAY_MS);
  return () => clearTimeout(timer);
}

export function setFirstRefresh(done: boolean | undefined | null) {
  firstRefresh.done = done ?? undefined;
  firstRefresh.settled = true;
}

// The snapshot request failed or never ran: the flag stays unknown, and the
// page shows its real state.
export function settleFirstRefresh() {
  firstRefresh.settled = true;
}
