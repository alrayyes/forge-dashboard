// What an open pipeline panel does with a changed list of checks: keep the
// order it shows, name what changed and key each check. No DOM here.
import { CHECK_STATE_LABELS, type Check, checkState } from './pipeline-checks';

// What the open panel's checks say, from the facts the stream sends: each
// check's run, attempt, status and conclusion. Equal signatures mean nothing
// moved, so a control that waits for the pipeline to move has nothing new. A
// rerun changes it: the run's attempt, or its run, is new.
export function runSignature(checks: Check[]): string {
  return checks
    .map((c) =>
      [
        c.name,
        c.url,
        c.runId ?? '',
        c.runAttempt ?? '',
        c.status,
        c.conclusion ?? '',
      ].join(':'),
    )
    .sort()
    .join('|');
}

// The newest checks in the order the panel already shows them, so a check's
// pill changes where it stands. Matches by name, and the nth check of a shared
// name to the nth of the old list. New checks go last; gone ones drop out.
export function keepOrder(prev: Check[], next: Check[]): Check[] {
  const pool = new Map<string, Check[]>();
  for (const check of next) {
    const list = pool.get(check.name) ?? [];
    list.push(check);
    pool.set(check.name, list);
  }
  const out: Check[] = [];
  for (const old of prev) {
    const hit = pool.get(old.name)?.shift();
    if (hit) out.push(hit);
  }
  for (const rest of pool.values()) out.push(...rest);

  return out;
}

// A check's key: its name, and for the nth check of a shared name `name#n`.
// It does not move when other checks come or go, so a redraw can find the
// control the keyboard was on. Same order as the list given.
export function checkKeys(checks: Check[]): string[] {
  const seen = new Map<string, number>();

  return checks.map((check) => {
    const n = (seen.get(check.name) ?? 0) + 1;
    seen.set(check.name, n);

    return n === 1 ? check.name : `${check.name}#${n}`;
  });
}

// The one polite line for a live redraw, or nothing when no check changed.
export function announceChange(prev: Check[], next: Check[]): string {
  const before = new Map<string, string[]>();
  for (const c of prev) {
    const list = before.get(c.name) ?? [];
    list.push(checkState(c));
    before.set(c.name, list);
  }
  const changed: Check[] = [];
  for (const c of next) {
    const old = before.get(c.name)?.shift();
    if (old !== checkState(c)) changed.push(c);
  }
  if (changed.length === 0) return '';
  if (changed.length === 1) {
    const [c] = changed;
    const state = checkState(c);

    return `Checks updated: ${c.name} is now ${CHECK_STATE_LABELS[state] || state}.`;
  }

  return `Checks updated: ${changed.length} checks changed.`;
}
