// A pull request whose CI is failing never offers Merge: not on the row, not on
// the phone card, not in the pop-up's footer, armed or not, and whatever else
// also holds it back (draft, conflict, behind) (#4953, #4975, matching #4944).
// The status block says why. `ci` is the fact the server already sends on
// every pull request; the blocked code stays as a second way in.
export function dropsFailingMerge(
  ci: string | undefined,
  blockedCode: string | undefined,
): boolean {
  return ci === 'failure' || blockedCode === 'checks_failing';
}
