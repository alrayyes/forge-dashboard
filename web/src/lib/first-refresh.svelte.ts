// The latest `firstRefreshDone` any snapshot carried, shared by the dashboard
// views, the layout's nav pills and the Branches page (#1672). `done` is
// undefined until a snapshot has answered, and undefined again when the server
// sends none. `settled` says a snapshot request has finished one way or the
// other, so a page that waits for the flag cannot wait forever on a failure.
export const firstRefresh = $state<{
  done: boolean | undefined;
  settled: boolean;
}>({ done: undefined, settled: false });

export function setFirstRefresh(done: boolean | undefined | null) {
  firstRefresh.done = done ?? undefined;
  firstRefresh.settled = true;
}

// The snapshot request failed or never ran: the flag stays unknown, and the
// page shows its real state.
export function settleFirstRefresh() {
  firstRefresh.settled = true;
}
