/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createPresence, type PresenceTimings } from './presence';

// Pure state plus injected timers, so these run without a browser. The page
// wiring is covered by the hidden-tab journey.

function harness(
  timings: PresenceTimings = { heartbeatSeconds: 60, idleAfterSeconds: 900 },
) {
  let clock = 0;
  let nextHandle = 1;
  let visible = true;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sent: boolean[] = [];

  const presence = createPresence({
    now: () => clock,
    isVisible: () => visible,
    setTimer: (fn, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: clock + ms, fn });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    send: async (v) => {
      sent.push(v);
      return timings;
    },
  });

  async function flush() {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  }
  // Moves the clock, firing timers in order as their time comes.
  async function advance(ms: number) {
    const target = clock + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
      await flush();
    }
    clock = target;
  }

  return {
    presence,
    sent,
    advance,
    flush,
    setVisible(v: boolean) {
      visible = v;
      presence.visibilityChanged();
    },
  };
}

describe('presence', () => {
  test('a visible tab reports itself at once and again every heartbeat', async () => {
    const h = harness();
    h.presence.start();
    await h.flush();
    expect(h.sent).toEqual([true]);

    await h.advance(60_000);
    await h.advance(60_000);
    expect(h.sent).toEqual([true, true, true]);
  });

  test('a tab that starts hidden says nothing', async () => {
    const h = harness();
    h.setVisible(false);
    h.presence.start();
    await h.flush();
    await h.advance(10 * 60_000);
    expect(h.sent).toEqual([]);
  });

  test('hiding the tab says so once and stops the heartbeat', async () => {
    const h = harness();
    h.presence.start();
    await h.flush();

    h.setVisible(false);
    await h.flush();
    await h.advance(10 * 60_000);
    expect(h.sent).toEqual([true, false]);
  });

  test('showing the tab again reports at once', async () => {
    const h = harness();
    h.presence.start();
    await h.flush();
    h.setVisible(false);
    await h.flush();

    h.setVisible(true);
    await h.flush();
    expect(h.sent).toEqual([true, false, true]);
  });

  test('a visible tab with no input for the idle period lets go, input brings it back', async () => {
    const h = harness({ heartbeatSeconds: 60, idleAfterSeconds: 300 });
    h.presence.start();
    await h.flush();

    await h.advance(299_000);
    expect(h.sent.at(-1)).toBe(true);
    await h.advance(2_000);
    expect(h.sent.at(-1)).toBe(false);
    const afterIdle = h.sent.length;
    await h.advance(10 * 60_000);
    expect(h.sent.length).toBe(afterIdle);

    h.presence.input();
    await h.flush();
    expect(h.sent.at(-1)).toBe(true);
  });

  test('input keeps pushing the idle moment back', async () => {
    const h = harness({ heartbeatSeconds: 60, idleAfterSeconds: 300 });
    h.presence.start();
    await h.flush();

    for (let i = 0; i < 5; i++) {
      await h.advance(200_000);
      h.presence.input();
    }
    expect(h.sent.every((v) => v)).toBe(true);
  });

  test('an idle period of zero means the tab never goes input-idle', async () => {
    const h = harness({ heartbeatSeconds: 60, idleAfterSeconds: 0 });
    h.presence.start();
    await h.flush();
    await h.advance(5 * 3600_000);
    expect(h.sent.every((v) => v)).toBe(true);
  });

  test('a failed report is tried again on the next heartbeat', async () => {
    let fail = true as boolean;
    const sent: boolean[] = [];
    const timers: Array<() => void> = [];
    const presence = createPresence({
      now: () => 0,
      isVisible: () => true,
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => {},
      send: async (v) => {
        sent.push(v);
        return fail ? null : { heartbeatSeconds: 60, idleAfterSeconds: 0 };
      },
    });
    presence.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    fail = false;
    timers.at(-1)?.();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(sent).toEqual([true, true]);
  });

  test('stop cancels the timers and says the tab is gone', async () => {
    const h = harness();
    h.presence.start();
    await h.flush();
    h.presence.stop();
    await h.flush();
    await h.advance(3600_000);
    expect(h.sent).toEqual([true, false]);
  });
});
