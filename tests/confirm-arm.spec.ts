import { expect, test } from '@playwright/test';
import {
  CONFIRM_GUARD_MS,
  CONFIRM_TIMEOUT_MS,
  type ConfirmArmOptions,
  createConfirmArm,
  type DisarmReason,
} from '../web/src/lib/confirm-arm';

// The helper is pure state plus injected timers, so these run without a
// browser. The page wiring is covered by the pull-request-confirm journey.
// https://github.com/alrayyes/forge-dashboard/issues/764

function harness(overrides: Partial<ConfirmArmOptions> = {}) {
  let clock = 1000;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const disarmed: Array<[string, DisarmReason]> = [];

  const arm = createConfirmArm({
    now: () => clock,
    setTimer: (fn, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: clock + ms, fn });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    onDisarm: (key, reason) => {
      disarmed.push([key, reason]);
    },
    ...overrides,
  });

  function advance(ms: number) {
    const target = clock + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = target;
  }

  return { arm, advance, disarmed, timers };
}

test.describe('createConfirmArm', () => {
  test('arming tracks the one armed key', () => {
    const { arm } = harness();
    expect(arm.armedKey()).toBeNull();
    arm.arm('merge:a');
    expect(arm.armedKey()).toBe('merge:a');
    expect(arm.isArmed('merge:a')).toBe(true);
    expect(arm.isArmed('merge:b')).toBe(false);
  });

  test('arming a second key disarms the first with reason replaced', () => {
    const { arm, disarmed } = harness();
    arm.arm('merge:a');
    arm.arm('close:b');
    expect(arm.armedKey()).toBe('close:b');
    expect(disarmed).toEqual([['merge:a', 'replaced']]);
  });

  test('re-arming the same key restarts it without a disarm', () => {
    const { arm, advance, disarmed } = harness();
    arm.arm('merge:a');
    advance(5000);
    arm.arm('merge:a');
    expect(disarmed).toEqual([]);
    expect(arm.remainingMs()).toBe(CONFIRM_TIMEOUT_MS);
  });

  test('disarms itself after the timeout with reason timeout', () => {
    const { arm, advance, disarmed } = harness();
    arm.arm('merge:a');
    advance(CONFIRM_TIMEOUT_MS - 1);
    expect(arm.armedKey()).toBe('merge:a');
    advance(1);
    expect(arm.armedKey()).toBeNull();
    expect(disarmed).toEqual([['merge:a', 'timeout']]);
  });

  test('pausing stops the countdown and resuming carries on from where it was', () => {
    const { arm, advance, disarmed } = harness();
    arm.arm('merge:a');
    advance(3000);
    arm.pause();
    advance(60_000);
    expect(arm.armedKey()).toBe('merge:a');
    expect(arm.remainingMs()).toBe(CONFIRM_TIMEOUT_MS - 3000);
    arm.resume();
    advance(CONFIRM_TIMEOUT_MS - 3000 - 1);
    expect(disarmed).toEqual([]);
    advance(1);
    expect(disarmed).toEqual([['merge:a', 'timeout']]);
  });

  test('a pause that began before arming does not leak into the next arm', () => {
    const { arm, advance } = harness();
    arm.arm('merge:a');
    arm.pause();
    arm.disarm('cancel');
    arm.arm('merge:b');
    advance(CONFIRM_TIMEOUT_MS);
    expect(arm.armedKey()).toBeNull();
  });

  test('disarm names the reason, is idempotent and clears the timer', () => {
    const { arm, disarmed, timers } = harness();
    arm.arm('merge:a');
    expect(arm.disarm('escape')).toBe(true);
    expect(arm.disarm('escape')).toBe(false);
    expect(disarmed).toEqual([['merge:a', 'escape']]);
    expect(timers.size).toBe(0);
  });

  test('disarm with a key only acts when that key is the armed one', () => {
    const { arm, disarmed } = harness();
    arm.arm('merge:a');
    expect(arm.disarm('dropped', 'merge:b')).toBe(false);
    expect(arm.armedKey()).toBe('merge:a');
    expect(arm.disarm('dropped', 'merge:a')).toBe(true);
    expect(disarmed).toEqual([['merge:a', 'dropped']]);
  });

  test('the guard holds for a short moment after arming, then lifts', () => {
    const { arm, advance } = harness();
    expect(arm.guardActive('merge:a')).toBe(false);
    arm.arm('merge:a');
    expect(arm.guardActive('merge:a')).toBe(true);
    expect(arm.guardActive('merge:b')).toBe(false);
    advance(CONFIRM_GUARD_MS - 1);
    expect(arm.guardActive('merge:a')).toBe(true);
    advance(1);
    expect(arm.guardActive('merge:a')).toBe(false);
  });

  test('a paused arm still reports how much of the countdown has gone', () => {
    const { arm, advance } = harness();
    arm.arm('merge:a');
    advance(2000);
    expect(arm.elapsedMs()).toBe(2000);
    arm.pause();
    advance(1000);
    expect(arm.elapsedMs()).toBe(2000);
  });
});
