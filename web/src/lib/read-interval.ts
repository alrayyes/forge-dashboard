// How often the page re-reads the dashboard. The server advises it on every
// snapshot (`readIntervalSeconds`) and the page follows it, so a short advice
// while the first refresh runs brings the rows in soon after it ends.

// A browser timer given more than 2^31 ms fires at once, so an absurd advice
// would turn the poll into a tight loop. Past this, the page keeps its cap.
export const MAX_READ_INTERVAL_SECONDS = 300;

// A missing, non-numeric, zero, negative or sub-second advice is ignored and
// the current interval stays; a huge one is capped.
export function adviseReadIntervalMs(
  seconds: number | null | undefined,
  currentMs: number,
): number {
  if (typeof seconds !== 'number' || !(seconds >= 1)) return currentMs;
  return Math.min(seconds, MAX_READ_INTERVAL_SECONDS) * 1000;
}
