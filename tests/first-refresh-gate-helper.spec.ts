import { expect, test } from '@playwright/test';
import { createFirstRefreshGate, twoFrames } from './first-refresh-gate-helper';

// #2195: the gate in front of the main branches list answer. State only, no
// browser, so it does not need a server.

const T = { startMs: 150, servedMs: 600 };
const took = async (fn: () => Promise<unknown>) => {
  const t = Date.now();
  await fn();
  return Date.now() - t;
};

test.describe('first-refresh gate (#2195)', () => {
  test('waits for the dashboard answer of the document', async () => {
    const gate = createFirstRefreshGate(T);
    gate.newDocument();
    gate.dashboardStarted();
    setTimeout(() => gate.dashboardServed(), 80);
    const ms = await took(() => gate.wait());
    expect(ms).toBeGreaterThanOrEqual(70);
    expect(ms).toBeLessThan(T.servedMs);
  });

  test('a second list read in the same document waits again', async () => {
    const gate = createFirstRefreshGate(T);
    gate.newDocument();
    gate.dashboardStarted();
    gate.dashboardServed();
    await gate.wait();
    // The poll after the first answer starts another dashboard read.
    gate.dashboardStarted();
    setTimeout(() => gate.dashboardServed(), 80);
    expect(await took(() => gate.wait())).toBeGreaterThanOrEqual(70);
  });

  test('a read from the previous document does not satisfy the next', async () => {
    const gate = createFirstRefreshGate(T);
    gate.newDocument();
    gate.dashboardStarted();
    gate.dashboardServed();
    gate.newDocument();
    gate.dashboardStarted();
    setTimeout(() => gate.dashboardServed(), 80);
    expect(await took(() => gate.wait())).toBeGreaterThanOrEqual(70);
  });

  test('a document that reuses a cached read does not pay the full wait', async () => {
    const gate = createFirstRefreshGate(T);
    gate.newDocument();
    expect(await took(() => gate.wait())).toBeLessThan(T.servedMs);
  });

  test('a dashboard read that is never answered gives up', async () => {
    const gate = createFirstRefreshGate(T);
    gate.newDocument();
    gate.dashboardStarted();
    expect(await took(() => gate.wait())).toBeLessThan(T.servedMs + 300);
  });

  test('the frame wait times out on a page that never paints', async () => {
    const never = {
      // requestAnimationFrame never fires: the callback is dropped.
      evaluate: async <T>(fn: (ms: number) => Promise<T>, ms: number) => {
        (globalThis as Record<string, unknown>).requestAnimationFrame = () => 0;
        return fn(ms);
      },
    };
    expect(await took(() => twoFrames(never, 200))).toBeLessThan(1000);
  });
});
