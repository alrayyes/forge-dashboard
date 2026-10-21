import { expect, test } from '@playwright/test';
import { createFirstRefreshGate, twoFrames } from './first-refresh-gate-helper';

// #2195: the gate in front of the main branches list answer. State only, no
// browser, so it does not need a server.

const T = { startMs: 150, servedMs: 600 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const took = async (fn: () => Promise<unknown>) => {
  const t = Date.now();
  await fn();
  return Date.now() - t;
};

test.describe('first-refresh gate (#2195)', () => {
  test('waits for the dashboard answer of the document', async () => {
    const gate = createFirstRefreshGate(T);
    gate.newDocument();
    gate.trackDashboard(() => sleep(80));
    const ms = await took(() => gate.wait());
    expect(ms).toBeGreaterThanOrEqual(70);
    expect(ms).toBeLessThan(T.servedMs);
  });

  test('a second list read in the same document waits again', async () => {
    const gate = createFirstRefreshGate(T);
    gate.newDocument();
    gate.trackDashboard(async () => {});
    await gate.wait();
    // The poll after the first answer starts another dashboard read.
    gate.trackDashboard(() => sleep(80));
    expect(await took(() => gate.wait())).toBeGreaterThanOrEqual(70);
  });

  test('a read from the previous document does not satisfy the next', async () => {
    const gate = createFirstRefreshGate(T);
    gate.newDocument();
    gate.trackDashboard(async () => {});
    gate.newDocument();
    gate.trackDashboard(() => sleep(80));
    expect(await took(() => gate.wait())).toBeGreaterThanOrEqual(70);
  });

  test('a document that reuses a cached read does not pay the full wait', async () => {
    const gate = createFirstRefreshGate(T);
    gate.newDocument();
    // It only pays the start wait, not the served wait.
    const ms = await took(() => gate.wait());
    expect(ms).toBeGreaterThanOrEqual(T.startMs - 20);
    expect(ms).toBeLessThan(T.startMs + 200);
  });

  test('a dashboard handler that throws still counts as answered', async () => {
    const gate = createFirstRefreshGate(T);
    gate.newDocument();
    await gate
      .trackDashboard(async () => {
        throw new Error('fulfill failed');
      })
      .catch(() => {});
    expect(await took(() => gate.wait())).toBeLessThan(T.startMs);
  });

  test('a late handler from the previous document leaves the new counters alone', async () => {
    const gate = createFirstRefreshGate(T);
    gate.newDocument();
    let finish = () => {};
    const late = gate.trackDashboard(
      () => new Promise<void>((r) => (finish = r)),
    );
    gate.newDocument();
    gate.trackDashboard(() => new Promise<void>(() => {}));
    finish();
    await late;
    // The new document's read is still open, so the gate has to wait it out.
    expect(await took(() => gate.wait())).toBeGreaterThanOrEqual(
      T.servedMs - 50,
    );
  });

  test('a dashboard read that is never answered gives up', async () => {
    const gate = createFirstRefreshGate(T);
    gate.newDocument();
    gate.trackDashboard(() => new Promise<void>(() => {}));
    expect(await took(() => gate.wait())).toBeLessThan(T.servedMs + 300);
  });

  test('the frame wait times out on a page that never paints', async () => {
    const g = globalThis as Record<string, unknown>;
    const had = 'requestAnimationFrame' in g;
    const original = g.requestAnimationFrame;
    const never = {
      // requestAnimationFrame never fires: the callback is dropped.
      evaluate: async <T>(fn: (ms: number) => Promise<T>, ms: number) => {
        g.requestAnimationFrame = () => 0;
        return fn(ms);
      },
    };
    try {
      expect(await took(() => twoFrames(never, 200))).toBeLessThan(1000);
    } finally {
      if (had) g.requestAnimationFrame = original;
      else delete g.requestAnimationFrame;
    }
  });

  test('the frame wait test leaves requestAnimationFrame as it found it', () => {
    expect(
      (globalThis as Record<string, unknown>).requestAnimationFrame,
    ).toBeUndefined();
  });
});
