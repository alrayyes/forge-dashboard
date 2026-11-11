// "Rebase all" on the Bots page (#2859). It picks the listed rows that are
// behind their base and asks each bot to rebase through the per-row action
// the server already offers, so it holds no rule of its own about who may.

import { type AllowedAction, findAction } from './allowed-actions';
import { isFailing } from './filters';

export type RebaseRow = {
  forge: string;
  repo: string;
  number: number;
  title: string;
  behind?: boolean;
  empty?: boolean;
  // What the Failing CI pill reads, so the strip counts the same rows.
  ci?: string;
  failingCi?: boolean;
  allowedActions?: AllowedAction[];
};

export type Bot = 'dependabot' | 'renovate';

export type Eligible<T extends RebaseRow> = { item: T; bot: Bot };

// A row behind its base that Rebase all won't ask, and why, in the words the
// row itself uses (#3281).
export type LeftOut<T extends RebaseRow> = { item: T; reason: string };

export const REQUESTED_REASON = 'Rebase requested.';
export const NO_REBASE_REASON = 'No rebase is offered for this pull request.';

export type RebasePlan<T extends RebaseRow> = {
  eligible: Eligible<T>[];
  // Rows behind their base that are not asked, each with its reason.
  leftOut: LeftOut<T>[];
  // Rows listed, whether or not they are behind.
  total: number;
  // Rows behind their base, whether or not a rebase can be asked for.
  behind: number;
  // Rows listed, behind or not, that the Failing CI pill counts (#3276).
  failing: number;
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

// What the server said when it listed a rebase but blocked it, else a plain
// statement that none is offered.
function noBotReason(item: RebaseRow): string {
  const listed =
    findAction(item, 'dependabot_rebase') ??
    findAction(item, 'renovate_rebase');
  return listed?.blocked?.message || NO_REBASE_REASON;
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
  const leftOut: LeftOut<T>[] = [];
  const blockedReasons: string[] = [];
  let behind = 0;
  let failing = 0;
  for (const item of items) {
    if (isFailing(item)) failing++;
    if (!isOutOfDate(item)) continue;
    behind++;
    if (requested?.(item)) {
      leftOut.push({ item, reason: REQUESTED_REASON });
      continue;
    }
    const bot = botFor(item);
    if (!bot) {
      leftOut.push({ item, reason: noBotReason(item) });
      continue;
    }
    if (bot === 'dependabot') {
      const reason = blockedReason(item.forge);
      if (reason) {
        if (!blockedReasons.includes(reason)) blockedReasons.push(reason);
        leftOut.push({ item, reason });
        continue;
      }
    }
    eligible.push({ item, bot });
  }
  return {
    eligible,
    leftOut,
    total: items.length,
    behind,
    failing,
    blockedReasons,
  };
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

// The header's reason line when some behind rows can run and some can't.
export function leftOutLine(
  asking: number,
  reasons: readonly string[],
): string {
  const unique = [...new Set(reasons)];
  const verb = reasons.length === 1 ? 'is' : 'are';
  return `${asking} can be rebased. ${reasons.length} ${verb} left out: ${unique.join(' ')}`;
}
