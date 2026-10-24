// Which Dependabot command buttons a pull request gets, and which of them are
// locked. Pure: Dashboard.svelte hands in what it knows and draws the answer.

import { isReadOnlyLock, type LockInfo } from './lock-info';

export type DependabotAction = 'rebase' | 'recreate';

export const DEPENDABOT_ACTION_LABELS: Record<DependabotAction, string> = {
  rebase: 'Dependabot: Rebase',
  recreate: 'Dependabot: Recreate',
};

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

// Whether a command this page sent is still waiting on Dependabot. Dependabot
// has no command to withdraw one, so while either is waiting neither is drawn:
// the wait chip says what the pull request is waiting on. A request made
// elsewhere or before a reload is covered by the server, which then lists
// neither command at all.
export function dependabotCommandPending(
  prKey: string,
  states: Record<string, DependabotActionEntry>,
): boolean {
  return (['rebase', 'recreate'] as const).some((action) => {
    const phase = states[dependabotActionKey(prKey, action)]?.phase;
    return phase === 'queued' || phase === 'rebasing';
  });
}

// Why the server holds a listed command back (runs held for approval), or
// undefined.
export function dependabotServerLock(
  serverEntry: DependabotServerEntry | undefined,
): string | undefined {
  return serverEntry?.blocked?.message;
}

export type DependabotButtonInput = {
  prKey: string;
  action: DependabotAction;
  states: Record<string, DependabotActionEntry>;
  // Why Dependabot ignores this forge's credential (a GitHub App with no
  // personal token), or undefined.
  blockedReason: string | undefined;
  // Asked only when the action is idle, with the forge-wide lock below.
  serverEntry: () => DependabotServerEntry | undefined;
  // The forge-wide lock from the latest snapshot, or null. Asked only when the
  // action is idle, the one case that reads it.
  proactive: () => LockInfo | null;
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

  if (dependabotCommandPending(i.prKey, i.states)) return { kind: 'hidden' };

  if (entry.phase === 'idle') {
    const pending = dependabotServerLock(i.serverEntry());
    if (pending)
      return { kind: 'locked', lock: pending, printNote: i.printReason };
    // A forge that is spent or unreachable is read-only: one banner says so,
    // and no button is drawn on every row.
    const proactive = i.proactive();
    if (isReadOnlyLock(proactive)) return { kind: 'hidden' };
    if (proactive)
      return { kind: 'locked', lock: proactive, printNote: i.printReason };
    if (i.action === 'recreate' && i.confirmingRecreate)
      return { kind: 'confirm' };
  }

  return { kind: 'button', queued: false };
}
