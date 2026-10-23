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
  staleSince?: string;
};

// A forge that says it can't be reached. One that is silent on it is not
// treated as down. Every lock, banner and chip follows this one rule.
export function isUnreachable(h: { reachable?: boolean }): boolean {
  return h.reachable === false;
}

// True only for a forge that was asked and did not answer.
export function isOutage(h: StartingHealth): boolean {
  return isUnreachable(h) && !h.starting;
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
