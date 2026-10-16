// The latest `firstRefreshDone` any snapshot carried, shared by the dashboard
// views, the layout's nav pills and the Branches page (#1672). undefined until
// a snapshot has answered, and undefined again when the server sends none.
export const firstRefresh = $state<{ done: boolean | undefined }>({
  done: undefined,
});

export function setFirstRefresh(done: boolean | undefined | null) {
  firstRefresh.done = done ?? undefined;
}
