// When an open pipeline panel reads its checks again. The panel never polls:
// it reads again only when a snapshot says its pull request's or branch's CI
// changed, so nothing changing costs no forge request and a finished pipeline
// is never read again. No DOM here.
import type { CheckCounts } from './check-counts';
import { CHECK_STATE_LABELS, type Check } from './pipeline-checks';

// What a row says about its CI. Equal signatures mean the row's pill reads the
// same, so the panel behind it has nothing new to show.
export function ciSignature(row: {
  ci: string;
  checks?: CheckCounts;
  runUrl?: string;
}): string {
  const c = row.checks;

  return [
    row.ci,
    c
      ? `${c.passed}/${c.skipped ?? 0}/${c.running}/${c.waiting}/${c.failed}`
      : '',
    row.runUrl ?? '',
  ].join('|');
}

type LiveChecksOptions = {
  // The row's signature when the panel read its checks.
  signature: string;
  // Pause live updates is on: no request, whatever changed.
  paused: () => boolean;
  reload: () => void;
  // The panel may show old checks (true) or is current again (false).
  onStale: (stale: boolean) => void;
};

export type LiveChecks = {
  // The signature in the newest snapshot, or null when it no longer has the item.
  seen: (signature: string | null) => void;
  // Updates were turned back on.
  resume: () => void;
  // The panel read its checks by some other route, so it is current.
  refreshed: () => void;
  // A read made for a change failed: the next snapshot tries again.
  failed: () => void;
};

export function createLiveChecks(options: LiveChecksOptions): LiveChecks {
  let known = options.signature;
  let missed = false;

  return {
    seen(signature) {
      if (signature === null || signature === known) return;
      known = signature;
      if (options.paused()) {
        missed = true;
        options.onStale(true);

        return;
      }
      options.reload();
    },
    resume() {
      if (!missed) return;
      missed = false;
      options.onStale(false);
      options.reload();
    },
    failed() {
      known = '\u0000';
    },
    refreshed() {
      if (!missed) return;
      missed = false;
      options.onStale(false);
    },
  };
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
    list.push(c.state);
    before.set(c.name, list);
  }
  const changed: Check[] = [];
  for (const c of next) {
    const old = before.get(c.name)?.shift();
    if (old !== c.state) changed.push(c);
  }
  if (changed.length === 0) return '';
  if (changed.length === 1) {
    const [c] = changed;

    return `Checks updated: ${c.name} is now ${CHECK_STATE_LABELS[c.state] || c.state}.`;
  }

  return `Checks updated: ${changed.length} checks changed.`;
}
