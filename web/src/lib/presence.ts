// Tells the server whether this tab is being looked at, so the scheduled
// refresh can rest when nobody is. A tab counts while it is visible
// (Page Visibility API) and has had pointer, key or scroll input within the
// idle period, and keeps saying so on a slow heartbeat. A hidden tab sends
// nothing at all, so the browser's throttling of background timers cannot make
// a heartbeat late. Both timings come from the server's answer, so neither is
// hard-coded here.
//
// Pure state plus injected timers; presence-browser.ts holds the DOM wiring.

export type PresenceTimings = {
  heartbeatSeconds: number;
  idleAfterSeconds: number;
};

export type PresenceOptions = {
  now: () => number;
  isVisible: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  // Resolves the server's timings, or null when the report did not get through.
  send: (visible: boolean) => Promise<PresenceTimings | null>;
};

// Used until the first answer says otherwise.
const FALLBACK_HEARTBEAT_MS = 60_000;

export function createPresence(opts: PresenceOptions) {
  let running = false;
  let heartbeatMs = FALLBACK_HEARTBEAT_MS;
  let idleAfterMs = 0;
  let lastInput = opts.now();
  let inputIdle = false;
  // What the server was last told, counting a report still in flight (the tab
  // may hide before the answer); null until a report was sent, and again after
  // one that did not get through.
  let reported: boolean | null = null;
  let heartbeatTimer: unknown;
  let idleTimer: unknown;

  const wanted = () => running && opts.isVisible() && !inputIdle;

  function report(visible: boolean) {
    reported = visible;
    void opts.send(visible).then((timings) => {
      if (!timings) {
        if (reported === visible) reported = null;
        return;
      }
      heartbeatMs = Math.max(1, timings.heartbeatSeconds) * 1000;
      idleAfterMs = Math.max(0, timings.idleAfterSeconds) * 1000;
      if (visible) armIdle();
    });
  }

  function armHeartbeat() {
    opts.clearTimer(heartbeatTimer);
    heartbeatTimer = opts.setTimer(() => {
      if (!wanted()) return;
      report(true);
      armHeartbeat();
    }, heartbeatMs);
  }

  function armIdle() {
    opts.clearTimer(idleTimer);
    idleTimer = undefined;
    if (idleAfterMs <= 0 || !wanted()) return;
    const left = lastInput + idleAfterMs - opts.now();
    idleTimer = opts.setTimer(
      () => {
        idleTimer = undefined;
        if (opts.now() - lastInput < idleAfterMs) {
          armIdle();
          return;
        }
        inputIdle = true;
        sync();
      },
      Math.max(left, 1),
    );
  }

  // Brings what the server knows in line with what is true now.
  function sync() {
    if (wanted()) {
      if (reported !== true) report(true);
      armHeartbeat();
      armIdle();
      return;
    }
    opts.clearTimer(heartbeatTimer);
    opts.clearTimer(idleTimer);
    idleTimer = undefined;
    // A tab that never told the server it was visible has nothing to retract.
    if (reported === true) {
      reported = false;
      void opts.send(false);
    }
  }

  return {
    start() {
      running = true;
      lastInput = opts.now();
      inputIdle = false;
      sync();
    },
    stop() {
      running = false;
      sync();
    },
    visibilityChanged() {
      if (opts.isVisible()) {
        lastInput = opts.now();
        inputIdle = false;
      }
      sync();
    },
    // Pointer, key or scroll input. Cheap: it only records the time, and the
    // idle timer reads it when it fires.
    input() {
      lastInput = opts.now();
      if (inputIdle) {
        inputIdle = false;
        sync();
      }
    },
  };
}
