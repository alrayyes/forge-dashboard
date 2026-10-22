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

// True only for a forge that was asked and did not answer.
export function isOutage(h: StartingHealth): boolean {
  return !h.reachable && !h.starting;
}

export function chipLabel(name: string, h: StartingHealth): string {
  if (h.starting) return `${name} loading`;
  return `${name} ${h.reachable ? 'reachable' : 'unreachable'}`;
}

// What the health live region says for one forge, before any budget text.
export function healthSentence(name: string, h: StartingHealth): string {
  if (h.starting) return `${name} starting up`;
  return `${name} ${h.reachable ? 'reachable' : 'unreachable'}`;
}

// The plain line beside the chip saying the rows are old, or null when the
// rows are current. `ago` is the formatted age.
export function staleNote(h: StartingHealth, ago: string): string | null {
  if (h.starting) return `Starting up, showing data from ${ago}`;
  if (!h.reachable && h.staleSince) return `Showing data from ${ago}`;
  return null;
}
