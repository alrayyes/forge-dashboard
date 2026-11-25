// What a Settings, Repositories row says about a repo whose fetch failed. The
// server sends the time of the first failure in `failingSince` and works out
// the cutoff as `failingForGood`; the page only words them.

export type FailingFields = {
  failingSince?: string;
  failingForGood?: boolean;
};

export type FailingBadge = {
  // "Failing since 14:00 CET", or "Still failing since ..." past the cutoff.
  label: string;
  forGood: boolean;
  // The line under the badge: why the row's pull requests may be old.
  note: string;
};

export function failingBadge(
  repo: FailingFields,
  formatTime: (iso: string) => string,
): FailingBadge | null {
  if (!repo.failingSince) return null;
  const forGood = repo.failingForGood === true;
  return {
    label: `${forGood ? 'Still failing' : 'Failing'} since ${formatTime(repo.failingSince)}`,
    forGood,
    note: forGood
      ? "Retrying hasn't helped. Its pull requests and issues are the last ones it could read."
      : "The dashboard can't fetch this repo, so its pull requests and issues are the last ones it could read.",
  };
}
