// "Rerun failed checks" on the Pull requests and Bots pages (#3236). It sorts
// the listed failing rows before it sends anything, then reruns each chosen
// row through the per-row rerun the pipeline dialog already uses. It holds no
// rule of its own about who may: the server's allowed actions, the forge's
// lock and the server's own look at the head commit (GET
// /api/v1/pull-requests/rerunnable) decide, and this only files the answers.

import { type AllowedAction, findAction } from './allowed-actions';
import { isFailing } from './filters';

export type RerunRow = {
  forge: string;
  repo: string;
  number: number;
  title: string;
  ci?: string;
  failingCi?: boolean;
  allowedActions?: AllowedAction[];
};

// What the server said about one row: a job to rerun, none and why, or that
// it could not look (the forge was slow, a limit hit). An unknown row is sent
// anyway, and the forge's refusal, if any, shows in the summary.
export type Probe =
  | { rerunnable: true }
  | { rerunnable: false; reason: string }
  | { unknown: true };

export type LeftOut<T extends RerunRow> = { item: T; reason: string };

export type RerunPlan<T extends RerunRow> = {
  eligible: T[];
  // Failing rows a rerun won't touch, each with its reason.
  leftOut: LeftOut<T>[];
  // Failing rows the server has not answered for yet.
  checking: T[];
  // Rows listed, whether or not they fail.
  total: number;
  // Rows listed whose CI is failing.
  failing: number;
};

export const QUEUED_REASON = 'A rerun is already queued.';
export const NOT_OFFERED_REASON = 'No rerun is offered for this pull request.';
export const NOTHING_TO_RERUN_REASON =
  "Failing on an external CI, or no job ran. It can't be rerun from here.";

type PlanOptions<T extends RerunRow> = {
  // The server's answer for a row, or nothing while it has not come.
  probe: (item: T) => Probe | undefined;
  // Why a forge's rows can't be rerun now (unreachable, rate limited, too
  // old), or nothing.
  lockReason: (forge: string) => string | undefined;
  // A rerun already asked for and waiting on the next snapshot.
  queued?: (item: T) => boolean;
};

// The server's sentence as a sentence. Its "nothing to rerun" answer reads as
// the ticket's external CI wording.
function sentence(reason: string): string {
  if (reason.startsWith('no failed')) return NOTHING_TO_RERUN_REASON;
  const text = reason.charAt(0).toUpperCase() + reason.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function offeredReason(item: RerunRow): string | undefined {
  const action = findAction(item, 'rerun_checks');
  if (!action) return NOT_OFFERED_REASON;
  return action.blocked
    ? action.blocked.message || NOT_OFFERED_REASON
    : undefined;
}

export function rerunAllPlan<T extends RerunRow>(
  items: readonly T[],
  { probe, lockReason, queued }: PlanOptions<T>,
): RerunPlan<T> {
  const eligible: T[] = [];
  const leftOut: LeftOut<T>[] = [];
  const checking: T[] = [];
  let failing = 0;
  for (const item of items) {
    if (!isFailing(item)) continue;
    failing++;
    const notOffered = offeredReason(item);
    if (notOffered) {
      leftOut.push({ item, reason: notOffered });
      continue;
    }
    if (queued?.(item)) {
      leftOut.push({ item, reason: QUEUED_REASON });
      continue;
    }
    const locked = lockReason(item.forge);
    if (locked) {
      leftOut.push({ item, reason: locked });
      continue;
    }
    const answer = probe(item);
    if (!answer) checking.push(item);
    else if ('unknown' in answer || answer.rerunnable) eligible.push(item);
    else leftOut.push({ item, reason: sentence(answer.reason) });
  }
  return { eligible, leftOut, checking, total: items.length, failing };
}

// The control only earns its place when something listed is failing. A run in
// progress keeps it, so the progress count doesn't vanish mid-run.
export function showRerunAll<T extends RerunRow>(
  plan: RerunPlan<T>,
  running: boolean,
): boolean {
  return plan.failing > 0 || running;
}

export function rerunAllLabel(count: number): string {
  return count > 0 ? `Rerun failed checks (${count})` : 'Rerun failed checks';
}

export function rerunProgressLabel(done: number, count: number): string {
  return `Rerunning ${done} of ${count}`;
}

// The button's description and tooltip when nothing failing can be rerun.
export function rerunNoneLine(failing: number): string {
  return failing === 1
    ? "The failing pull request can't be rerun from here."
    : `None of the ${failing} failing pull requests can be rerun from here.`;
}
