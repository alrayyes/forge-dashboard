// "Update all" on the Pull requests page (#3011). It picks the listed rows the
// server says can be brought up to date and updates each through the per-row
// Update branch, so it holds no rule of its own about what may update. Bot
// pull requests are listed on the Bots page, not here.

import { type AllowedAction, findAction } from './allowed-actions';
import type { AutoUpdate } from './auto-update';

export type UpdateRow = {
  allowedActions?: AllowedAction[];
  // A row the dashboard already keeps current on its own needs no update.
  autoUpdate?: AutoUpdate;
};

export type UpdatePlan<T extends UpdateRow> = {
  eligible: T[];
  // Rows listed, whether or not they can be updated.
  total: number;
};

type PlanOptions<T extends UpdateRow> = {
  // An update already asked for and waiting on the next snapshot.
  updating?: (item: T) => boolean;
};

export function updateAllPlan<T extends UpdateRow>(
  items: readonly T[],
  { updating }: PlanOptions<T> = {},
): UpdatePlan<T> {
  const eligible = items.filter((item) => {
    const update = findAction(item, 'update_branch');
    return (
      update !== undefined &&
      !update.blocked &&
      !item.autoUpdate?.enabled &&
      !updating?.(item)
    );
  });
  return { eligible, total: items.length };
}

// The rows to update once the person has unticked some. When the plan is read
// again at confirm time, `current` drops a row that stopped being offered since
// the dialog opened, so the run never updates something the server now blocks.
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

// The control only earns its place when a listed row can be updated. A run in
// progress keeps it, so the progress count doesn't vanish mid-run.
export function showUpdateAll<T extends UpdateRow>(
  plan: UpdatePlan<T>,
  running: boolean,
): boolean {
  return plan.eligible.length > 0 || running;
}

export function updateAllLabel(count: number): string {
  return count > 0 ? `Update all (${count})` : 'Update all';
}

export function summaryLine(count: number, total: number): string {
  return `${count} of ${total} ${count === 1 ? 'is' : 'are'} out of date.`;
}

export function progressLabel(done: number, count: number): string {
  return `Updating ${done} of ${count}`;
}
