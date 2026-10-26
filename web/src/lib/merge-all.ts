// "Merge all" on the Pull requests page (#2860). It picks the listed rows the
// server says can merge now and merges each through the per-row Merge, so it
// holds no rule of its own about what may merge. Bot pull requests are listed
// on the Bots page, not here.

import { type AllowedAction, findAction } from './allowed-actions';

export type MergeRow = {
  allowedActions?: AllowedAction[];
};

export type MergePlan<T extends MergeRow> = {
  eligible: T[];
  // Rows listed, whether or not they can merge.
  total: number;
};

type PlanOptions<T extends MergeRow> = {
  // A merge already asked for and waiting on the next snapshot.
  merging?: (item: T) => boolean;
};

export function mergeAllPlan<T extends MergeRow>(
  items: readonly T[],
  { merging }: PlanOptions<T> = {},
): MergePlan<T> {
  const eligible = items.filter((item) => {
    const merge = findAction(item, 'merge');
    return merge !== undefined && !merge.blocked && !merging?.(item);
  });
  return { eligible, total: items.length };
}

// The rows to merge once the person has unticked some. When the plan is read
// again at confirm time, `current` drops a row that stopped being ready since
// the dialog opened, so the run never merges something the server now blocks.
export function chosenRows<T>(
  shown: readonly T[],
  left: ReadonlySet<string>,
  keyOf: (item: T) => string,
  current?: readonly T[],
): T[] {
  const stillReady = current && new Set(current.map(keyOf));
  return shown.filter((item) => {
    const key = keyOf(item);
    return !left.has(key) && (!stillReady || stillReady.has(key));
  });
}

export function mergeAllLabel(count: number): string {
  return count > 0 ? `Merge all (${count})` : 'Merge all';
}

export function summaryLine(count: number, total: number): string {
  if (count === 0) return 'Nothing is ready to merge.';
  return `${count} of ${total} ${count === 1 ? 'is' : 'are'} ready to merge.`;
}

export function progressLabel(done: number, count: number): string {
  return `Merging ${done} of ${count}`;
}

// What the server said about the source branch of a merged pull request:
// `outcome` is deleted, skipped or failed, and `reason` says why it was
// skipped. The reason is an open set, so one this page has no words for still
// reads as a kept branch.
export type BranchDeletion = { outcome: string; reason?: string };

const KEPT_BECAUSE: Record<string, string> = {
  fork: 'it lives in a fork',
  default_branch: 'it is the default branch',
  protected: 'it is protected',
};

// A note for the person, or undefined when nothing needs saying.
export function branchNote(
  deletion: BranchDeletion | undefined,
): string | undefined {
  if (!deletion) return undefined;
  if (deletion.outcome === 'failed') return 'The branch could not be deleted.';
  if (deletion.outcome !== 'skipped') return undefined;
  const because = deletion.reason && KEPT_BECAUSE[deletion.reason];
  return because ? `Branch kept: ${because}.` : 'Branch kept.';
}
