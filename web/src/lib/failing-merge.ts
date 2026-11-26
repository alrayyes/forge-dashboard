// A row whose CI is failing never offers Merge, armed or not (#4953, matching
// #4944). The status block already says why, so the row draws no locked
// button either. The pop-up's footer keeps the locked Merge with its reason.
export function dropsFailingMerge(
  code: string | undefined,
  onRow: boolean,
): boolean {
  return onRow && code === 'checks_failing';
}
