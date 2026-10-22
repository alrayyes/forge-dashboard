// Which Dependabot command buttons a pull request gets, and which of them are
// locked. Pure: Dashboard.svelte hands in what it knows and draws the answer.

export type DependabotAction = 'rebase' | 'recreate';

export const DEPENDABOT_ACTION_LABELS: Record<DependabotAction, string> = {
  rebase: 'Dependabot: Rebase',
  recreate: 'Dependabot: Recreate',
};

export type LockInfo = { reason: string; code?: string; resetsAt?: string };

// The slice of the page's per-action state this reads.
export type DependabotActionEntry = {
  phase: string;
  reason?: string;
  code?: string;
};

// The slice of the server's allowed-action entry this reads.
export type DependabotServerEntry = {
  blocked?: { code?: string; message?: string };
};

// Rebase and Recreate are independent actions on the same pull request, each
// with its own in-flight and locked state, so one locking can't hide the other.
export function dependabotActionKey(
  prKey: string,
  action: DependabotAction,
): string {
  return `${prKey}:${action}`;
}

// Why a command can't be sent because the other one is pending, or undefined.
// Local state answers first, so the lock is there the moment a click queues
// the other command; the server's own entry covers a request made elsewhere
// or before a reload.
export function dependabotPendingReason(
  prKey: string,
  action: DependabotAction,
  states: Record<string, DependabotActionEntry>,
  serverEntry: DependabotServerEntry | undefined,
): string | undefined {
  const other: DependabotAction = action === 'rebase' ? 'recreate' : 'rebase';
  const phase = states[dependabotActionKey(prKey, other)]?.phase;
  if (phase === 'queued' || phase === 'rebasing')
    return `A Dependabot ${other === 'rebase' ? 'Rebase' : 'Recreate'} is pending on this pull request.`;
  return serverEntry?.blocked?.code === 'already_requested'
    ? serverEntry.blocked.message
    : undefined;
}

export type DependabotButtonInput = {
  prKey: string;
  action: DependabotAction;
  states: Record<string, DependabotActionEntry>;
  // Why Dependabot ignores this forge's credential (a GitHub App with no
  // personal token), or undefined.
  blockedReason: string | undefined;
  serverEntry: DependabotServerEntry | undefined;
  // The forge-wide lock from the latest snapshot, or null.
  proactive: LockInfo | null;
  confirmingRecreate: boolean;
  // Print the reason beside a pending or proactive lock, for the menu and
  // dialog, where a hover bubble would be clipped.
  printReason: boolean;
};

export type DependabotButtonDecision =
  | { kind: 'hidden' }
  | { kind: 'confirm' }
  | { kind: 'locked'; lock: string | LockInfo; printNote: boolean }
  | { kind: 'button'; queued: boolean };

export function dependabotButtonDecision(
  i: DependabotButtonInput,
): DependabotButtonDecision {
  const entry = i.states[dependabotActionKey(i.prKey, i.action)] ?? {
    phase: 'idle',
  };

  if (i.blockedReason)
    return { kind: 'locked', lock: i.blockedReason, printNote: false };

  if (entry.phase === 'locked')
    return {
      kind: 'locked',
      lock: { reason: entry.reason ?? '', code: entry.code },
      printNote: false,
    };

  if (entry.phase === 'idle') {
    const pending = dependabotPendingReason(
      i.prKey,
      i.action,
      i.states,
      i.serverEntry,
    );
    if (pending)
      return { kind: 'locked', lock: pending, printNote: i.printReason };
    // A forge that is spent or unreachable is read-only: one banner says so,
    // and no button is drawn on every row.
    if (
      i.proactive?.code === 'rate_limited' ||
      i.proactive?.code === 'forge_unreachable'
    )
      return { kind: 'hidden' };
    if (i.proactive)
      return { kind: 'locked', lock: i.proactive, printNote: i.printReason };
    if (i.action === 'recreate' && i.confirmingRecreate)
      return { kind: 'confirm' };
  }

  return {
    kind: 'button',
    queued: entry.phase === 'queued' || entry.phase === 'rebasing',
  };
}
