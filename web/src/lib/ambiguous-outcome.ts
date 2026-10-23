// A pull request action whose request rejected with no status (the browser
// never saw an answer) is ambiguous: the connection can drop after the server
// already acted. Every action settles that the same way, by reading the pull
// request again and checking for the action's effect, instead of reporting
// the rejection at face value.

export type AmbiguousOutcome<T> = { ran: boolean; data: T | null };

// `refresh` fetches a fresh snapshot (null when there is none); `ran` says
// whether that snapshot shows the action's effect. A refresh that fails too
// proves nothing, so it counts as "did not run" and the error stays.
export async function readAmbiguousOutcome<T>(
  refresh: () => Promise<T | null>,
  ran: (data: T) => boolean,
): Promise<AmbiguousOutcome<T>> {
  let data: T | null = null;
  try {
    data = await refresh();
  } catch {
    return { ran: false, data: null };
  }
  if (!data) return { ran: false, data: null };
  return { ran: ran(data), data };
}
