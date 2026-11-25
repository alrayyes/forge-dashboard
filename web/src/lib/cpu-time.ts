// Test helpers for CPU-time checks (issue 4812). A wall-clock reading moves with
// the load on the machine: a run that is descheduled for a while takes far
// longer and nothing in the code changed. So each sample is the CPU time the
// process spent (time spent waiting for a core doesn't count), and each check
// takes the fastest of several samples, the least disturbed run.

const SAMPLES = 5;
// The small run can take under a millisecond, where the clock's own jitter
// would decide the ratio. Safe for the markdown check: its small run uses
// about 28 ms of CPU, well above this, so the floor never hides a regression.
const FLOOR_MS = 5;

const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

/** The fastest of `samples` timed runs of `run`, of CPU time in milliseconds. */
export async function fastest(
  run: () => Promise<unknown> | unknown,
  samples = SAMPLES,
): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i++) {
    const start = cpuMs();
    await run();
    best = Math.min(best, cpuMs() - start);
  }
  return best;
}

/**
 * How much longer `run(large)` takes than `run(small)`. Linear work gives about
 * large / small and quadratic work about its square.
 */
export async function growth(
  run: (n: number) => Promise<unknown> | unknown,
  small: number,
  large: number,
  options: { samples?: number; floorMs?: number } = {},
): Promise<number> {
  const { samples = SAMPLES, floorMs = FLOOR_MS } = options;
  await run(Math.max(1, Math.floor(small / 50))); // warm up
  const base = await fastest(() => run(small), samples);
  const big = await fastest(() => run(large), samples);
  return big / Math.max(base, floorMs);
}
