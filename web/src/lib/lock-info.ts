// Why an action is locked, and the code that says what kind of wait it is when
// one is known: "rate_limited" and "permission" don't clear by clicking;
// anything else may.
export type LockInfo = { reason: string; code?: string; resetsAt?: string };

// A forge whose budget is spent, that can't be reached, or that is still
// starting is read-only: the controls that need it are not drawn at all, and
// one banner says so. A lock from a failed click still draws, with its reason.
// Every row action asks this one question, so a new read-only code lands in
// all of them at once.
export function isReadOnlyLock(lock: LockInfo | null | undefined): boolean {
  return (
    lock?.code === 'rate_limited' ||
    lock?.code === 'forge_unreachable' ||
    lock?.code === 'forge_starting'
  );
}
