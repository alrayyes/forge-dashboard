// The one armed confirm step on the board (#764): which action is waiting
// for its second click, when it gives up, and the short guard after arming
// that stops a double-click from confirming. Pure state with injectable
// timers, no DOM, so it outlives every row rebuild like mergeState and
// closeState do, and can be tested without a browser.

// How long an armed confirm waits before it disarms itself.
export const CONFIRM_TIMEOUT_MS = 8000;

// A second click this soon after arming is the tail of a double-click, not
// a decision. Long enough to cover a double-click interval, short enough
// that nobody confirming on purpose notices it.
export const CONFIRM_GUARD_MS = 400;

export type DisarmReason =
  | 'cancel'
  | 'outside'
  | 'escape'
  | 'timeout'
  | 'replaced'
  | 'dropped'
  | 'confirmed';

export type ConfirmArmOptions = {
  onDisarm: (key: string, reason: DisarmReason) => void;
  timeoutMs?: number;
  guardMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type ConfirmArm = {
  arm(key: string): void;
  disarm(reason: DisarmReason, key?: string): boolean;
  armedKey(): string | null;
  isArmed(key: string): boolean;
  guardActive(key: string): boolean;
  pause(): void;
  resume(): void;
  remainingMs(): number;
  elapsedMs(): number;
};

export function createConfirmArm(options: ConfirmArmOptions): ConfirmArm {
  const timeoutMs = options.timeoutMs ?? CONFIRM_TIMEOUT_MS;
  const guardMs = options.guardMs ?? CONFIRM_GUARD_MS;
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle) => globalThis.clearTimeout(handle as number));

  let armed: string | null = null;
  let armedAt = 0;
  let remaining = timeoutMs;
  let timerStartedAt = 0;
  let handle: unknown = null;
  let paused = false;

  function stopTimer() {
    if (handle !== null) clearTimer(handle);
    handle = null;
  }

  function startTimer() {
    stopTimer();
    timerStartedAt = now();
    handle = setTimer(() => {
      handle = null;
      remaining = 0;
      disarm('timeout');
    }, remaining);
  }

  function disarm(reason: DisarmReason, key?: string): boolean {
    if (armed === null) return false;
    if (key !== undefined && key !== armed) return false;
    const was = armed;
    stopTimer();
    armed = null;
    paused = false;
    options.onDisarm(was, reason);
    return true;
  }

  return {
    arm(key) {
      if (armed !== null && armed !== key) disarm('replaced');
      stopTimer();
      armed = key;
      armedAt = now();
      remaining = timeoutMs;
      // A pause held while nothing was armed must not freeze this one.
      paused = false;
      startTimer();
    },
    disarm,
    armedKey: () => armed,
    isArmed: (key) => armed === key,
    guardActive: (key) => armed === key && now() - armedAt < guardMs,
    pause() {
      if (armed === null || paused) return;
      remaining = Math.max(0, remaining - (now() - timerStartedAt));
      stopTimer();
      paused = true;
    },
    resume() {
      if (armed === null || !paused) return;
      paused = false;
      startTimer();
    },
    remainingMs() {
      if (armed === null) return 0;
      if (paused) return remaining;
      return Math.max(0, remaining - (now() - timerStartedAt));
    },
    elapsedMs() {
      return armed === null ? 0 : timeoutMs - this.remainingMs();
    },
  };
}
