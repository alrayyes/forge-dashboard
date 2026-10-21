// The gate the main branches spec puts in front of its list answer (#2195).
//
// The list waits for the layout's dashboard read to say the server's first
// refresh is done. If the list's own answer lands first and the dashboard
// read takes longer than the page's show delay, the page draws the rows,
// swaps them for a skeleton and draws them again. A click or a measurement
// in between hits nodes that are gone a moment later. Under load that is
// common, so each list answer waits for the dashboard read of the same
// document, and the page then has two frames to apply it.
//
// The gate is plain state with no browser in it, so a spec can drive it.

export type GateTimeouts = { startMs: number; servedMs: number };
export const GATE_TIMEOUTS: GateTimeouts = { startMs: 300, servedMs: 1500 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createFirstRefreshGate(timeouts: GateTimeouts = GATE_TIMEOUTS) {
  // Per document: dashboard requests started, and answered.
  let started = 0;
  let served = 0;
  // Bumped per document, so a handler left over from the one before cannot
  // count its answer against the next.
  let generation = 0;

  async function until(done: () => boolean, ms: number) {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await sleep(5);
  }

  return {
    newDocument() {
      generation++;
      started = 0;
      served = 0;
    },
    // Runs one dashboard handler and counts it answered when it settles,
    // thrown or not, so a failing `route.fulfill` cannot stall later list
    // reads. An answer that settles after a new document began is dropped.
    async trackDashboard<T>(handler: () => Promise<T>): Promise<T> {
      const mine = generation;
      started++;
      try {
        return await handler();
      } finally {
        if (mine === generation) served++;
      }
    },
    // Every list read asks, so a second read in the same document is gated
    // like the first. A document that never starts a dashboard request (it
    // reuses the read from the one before) only pays `startMs`.
    async wait() {
      if (started === 0) await until(() => started > 0, timeouts.startMs);
      if (started === 0) return;
      await until(() => served >= started, timeouts.servedMs);
    },
  };
}

// Two frames in the page, so it has applied what it was just given. Gives up
// after `ms` so a page that never paints cannot hang a route handler.
export async function twoFrames(
  page: {
    evaluate: <T>(fn: (ms: number) => Promise<T>, arg: number) => Promise<T>;
  },
  ms = 1000,
) {
  await page
    .evaluate(
      (limit) =>
        new Promise<void>((done) => {
          const timer = setTimeout(done, limit);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              clearTimeout(timer);
              done();
            }),
          );
        }),
      ms,
    )
    .catch(() => {});
}
