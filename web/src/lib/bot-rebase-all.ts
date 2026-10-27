// "Rebase all" on the Bots page (#2859). It picks the listed rows that are
// behind their base and asks each bot to rebase through the per-row action
// the server already offers, so it holds no rule of its own about who may.

import { type AllowedAction, findAction } from './allowed-actions';

export type RebaseRow = {
  forge: string;
  repo: string;
  number: number;
  title: string;
  behind?: boolean;
  empty?: boolean;
  allowedActions?: AllowedAction[];
};

export type Bot = 'dependabot' | 'renovate';

export type Eligible<T extends RebaseRow> = { item: T; bot: Bot };

export type RebasePlan<T extends RebaseRow> = {
  eligible: Eligible<T>[];
  // Rows listed, whether or not they are behind.
  total: number;
  // Rows behind their base, whether or not a rebase can be asked for.
  behind: number;
  // Why Dependabot rows that are behind were left out, each reason once.
  blockedReasons: string[];
};

type PlanOptions<T extends RebaseRow> = {
  // Why Dependabot commands are refused on a forge kind, or nothing.
  blockedReason: (forge: string) => string | undefined;
  // A request already made and waiting on the next snapshot.
  requested?: (item: T) => boolean;
};

function botFor(item: RebaseRow): Bot | null {
  const dependabot = findAction(item, 'dependabot_rebase');
  if (dependabot && !dependabot.blocked) return 'dependabot';
  const renovate = findAction(item, 'renovate_rebase');
  if (renovate && !renovate.blocked) return 'renovate';
  return null;
}

// The same two fields the row's Out of date badge reads.
function isOutOfDate(item: RebaseRow): boolean {
  return item.behind === true && item.empty !== true;
}

export function rebaseAllPlan<T extends RebaseRow>(
  items: readonly T[],
  { blockedReason, requested }: PlanOptions<T>,
): RebasePlan<T> {
  const eligible: Eligible<T>[] = [];
  const blockedReasons: string[] = [];
  let behind = 0;
  for (const item of items) {
    if (!isOutOfDate(item)) continue;
    behind++;
    if (requested?.(item)) continue;
    const bot = botFor(item);
    if (!bot) continue;
    if (bot === 'dependabot') {
      const reason = blockedReason(item.forge);
      if (reason) {
        if (!blockedReasons.includes(reason)) blockedReasons.push(reason);
        continue;
      }
    }
    eligible.push({ item, bot });
  }
  return { eligible, total: items.length, behind, blockedReasons };
}

// The control only earns its place when something listed is out of date. A
// run in progress keeps it, so the progress count doesn't vanish mid-run.
export function showRebaseAll<T extends RebaseRow>(
  plan: RebasePlan<T>,
  running: boolean,
): boolean {
  return plan.behind > 0 || running;
}

export function rebaseAllLabel(count: number): string {
  return count > 0 ? `Rebase all (${count})` : 'Rebase all';
}

export function summaryLine(count: number, total: number): string {
  if (count === 0) return 'Nothing is out of date.';
  return `${count} of ${total} ${count === 1 ? 'is' : 'are'} out of date.`;
}

export function progressLabel(done: number, count: number): string {
  return `Rebasing ${done} of ${count}`;
}
