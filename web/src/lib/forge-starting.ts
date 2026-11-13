// A restart shows the last run's rows before any forge has been asked. Those
// forges are "starting", which is not an outage: this module keeps the
// wording for each state in one place so the page never reads a start-up gap
// as "unreachable".

export type StartingHealth = {
  forge: string;
  reachable: boolean;
  // Set by the server while the rows are the saved ones and no fetch has
  // answered since the app started.
  starting?: boolean;
  errorKind?: string;
  staleSince?: string;
};

// A forge that says it can't be reached. One that is silent on it is not
// treated as down: a missing `reachable` counts as reachable, where the old
// `!reachable` test read it as down. The server always sends the field, so
// only a hand-built entry is affected. Every lock, banner and chip follows this one rule.
export function isUnreachable(h: { reachable?: boolean }): boolean {
  return h.reachable === false;
}

// True only for a forge that was asked and did not answer.
export function isOutage(h: StartingHealth): boolean {
  return isUnreachable(h) && !h.starting;
}

// An outage the server says is probably the first refresh still running: it
// restarted in the last few minutes (`recentlyStarted`) and the forge has not
// answered yet. A wrong token or instance URL is never that, so it keeps the
// outage wording.
export function isStartupGap(
  h: StartingHealth,
  recentlyStarted: boolean | undefined,
): boolean {
  if (!recentlyStarted || !isOutage(h)) return false;
  return (
    h.errorKind === undefined ||
    h.errorKind === 'unreachable' ||
    h.errorKind === 'upstream_error'
  );
}

// Whether the forge gets a chip under the header (#3681). A reachable forge
// with current rows and budget left has nothing to act on, so it draws none;
// the page's own fresh rows and "Refreshed" line already show it answered.
// An outage draws none either (#3719): the banner says it once. A forge that
// is rate limited as well has no unreachable banner, so it keeps its chip.
export function needsChip(h: StartingHealth, rateLimited: boolean): boolean {
  if (h.starting) return true;
  if (isUnreachable(h)) return rateLimited;
  return !!h.staleSince || rateLimited;
}

export function chipLabel(name: string, h: StartingHealth): string {
  if (h.starting) return `${name} loading`;
  return `${name} ${isUnreachable(h) ? 'unreachable' : 'reachable'}`;
}

// What the health live region says for one forge, before any budget text.
export function healthSentence(name: string, h: StartingHealth): string {
  if (h.starting) return `${name} starting up`;
  return `${name} ${isUnreachable(h) ? 'unreachable' : 'reachable'}`;
}

// The plain line beside the chip saying the rows are old, or null when the
// rows are current. `ago` is the formatted age.
export function staleNote(h: StartingHealth, ago: string): string | null {
  if (h.starting) return `Starting up, showing data from ${ago}`;
  if (isUnreachable(h) && h.staleSince) return `Showing data from ${ago}`;
  return null;
}

// The chip's class, from the same state as its label.
export function chipClass(h: StartingHealth): string {
  if (h.starting) return 'forge-health starting';
  return isUnreachable(h) ? 'forge-health unreachable' : 'forge-health';
}

// Stale rows split by why they are old: their forge is still starting up (the
// saved rows of the last run) or its fetch failed.
export function splitStaleRows<R extends { forge: string }>(
  rows: readonly R[],
  forges: readonly StartingHealth[] | undefined,
): { starting: R[]; outage: R[] } {
  const startingForges = new Set(
    (forges ?? []).filter((f) => f.starting).map((f) => f.forge),
  );
  return {
    starting: rows.filter((r) => startingForges.has(r.forge)),
    outage: rows.filter((r) => !startingForges.has(r.forge)),
  };
}
