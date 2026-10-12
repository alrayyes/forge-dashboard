// The words around hiding one pull request (#841). The server decides what is
// hidden and when a timed hide ends; this only says it in a sentence.

const DAY_MS = 24 * 60 * 60 * 1000;

// When a hidden pull request comes back: never on its own for one hidden
// until restored, otherwise the days left, rounded up so a hide that has 5.2
// days to go reads "Back in 6 days" and never "Back in 0 days".
export function comesBack(until: string | undefined, now = Date.now()): string {
  if (!until) return 'Hidden until you restore it';
  const left = new Date(until).getTime() - now;
  if (Number.isNaN(left) || left <= 0) return 'Back any moment';
  const days = Math.ceil(left / DAY_MS);
  return days === 1 ? 'Back in 1 day' : `Back in ${days} days`;
}

export type PullRequestName = { number: number; title: string };

// How a pull request is named in a message and on a button: the number and
// the title, so two with the same title can still be told apart.
export function nameOf(pr: PullRequestName): string {
  return `PR #${pr.number} ‘${pr.title}’`;
}

export const hidMessage = (pr: PullRequestName) => `Hid ${nameOf(pr)}.`;
export const restoredMessage = (pr: PullRequestName) =>
  `Restored ${nameOf(pr)}.`;
export const hideFailedMessage = (pr: PullRequestName) =>
  `Couldn’t hide ${nameOf(pr)}. Try again.`;
export const restoreFailedMessage = (pr: PullRequestName) =>
  `Couldn’t restore ${nameOf(pr)}. Try again.`;
