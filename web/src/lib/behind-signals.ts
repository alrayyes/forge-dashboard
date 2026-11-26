// What a row says about being behind the base branch, and when it stays
// quiet because something else already says it. Pure, so the rules are
// pinned without drawing a row.

export type BehindPillInput = {
  // The server's Out of date answer: behind with something left to merge.
  outOfDate: boolean;
  // A row in the list, not the details pop-up.
  onRow: boolean;
  conflictShown: boolean;
  liveUpdateBranch: boolean;
  // A bot rebase was asked for and hasn't timed out.
  rebaseRequested: boolean;
};

// The Out of date chip. On a row it stays out while the row already says it
// another way: a live Update branch, a confirmed conflict's warning (#3770),
// or a requested rebase, whose wait chip says the fix is under way. The
// pop-up keeps it, except beside a confirmed conflict: the pill and the block
// already say it there (#4531).
export function showsBehindPill(input: BehindPillInput): boolean {
  if (!input.outOfDate) return false;
  if (input.conflictShown) return false;
  if (!input.onRow) return true;
  return !(input.liveUpdateBranch || input.rebaseRequested);
}

// The "Behind the base branch" status block. A requested rebase on a row
// already does what it tells the reader to do. Every other status, and the
// pop-up, keeps its block.
export function showsBehindStatus(
  code: string | undefined,
  rebaseRequested: boolean,
  onRow: boolean,
): boolean {
  return !(onRow && code === 'behind' && rebaseRequested);
}

// A fix the row already asked for, so its own chip says it: a bot rebase or an
// Update branch.
export function fixRequested(
  rebaseRequested: boolean,
  updateRequested: boolean,
): boolean {
  return rebaseRequested || updateRequested;
}

// The locked Merge a behind row draws. Once Update branch is queued the wait
// clears by itself, so the row's chip is the one line and the locked button
// goes (#4532). The pop-up keeps it, and so does every block the person can
// act on.
export function dropsBehindMerge(
  code: string | undefined,
  updateRequested: boolean,
  onRow: boolean,
): boolean {
  return onRow && code === 'behind' && updateRequested;
}
