// Starting a read early for a pill the pointer rests on or the keyboard
// reaches, so the dialog it opens is usually ready on the first click. A
// pointer that only passes over starts nothing. No DOM here but `intentOn`.

type Handle = unknown;

export type WarmerOptions = {
  // How long the intent must hold before the read starts.
  delayMs?: number;
  // How long a held read is kept after the pointer or focus leaves.
  graceMs?: number;
  // How long a read that holds nothing counts as done, so a pointer going
  // back and forth does not read again.
  ttlMs?: number;
  // Starts the read for a key and returns what lets go of it, if it holds
  // anything.
  start: (key: string) => (() => void) | undefined;
  // False while nothing should be read, such as when live updates are paused.
  enabled?: () => boolean;
  // Only one key holds at a time: the intent on another key lets go of the
  // rest at once. For a hold that takes a slot of the stream's cap.
  exclusive?: boolean;
  set?: (fn: () => void, ms: number) => Handle;
  clear?: (handle: Handle) => void;
  now?: () => number;
};

type Entry = {
  at: number;
  // What lets go of the read. Gone once let go.
  release?: () => void;
  held: boolean;
  releaseTimer?: Handle;
};

export const PREFETCH_DELAY_MS = 120;
export const PREFETCH_GRACE_MS = 8_000;
export const PREFETCH_TTL_MS = 60_000;

export type Warmer = ReturnType<typeof createWarmer>;

export function createWarmer(options: WarmerOptions) {
  const delayMs = options.delayMs ?? PREFETCH_DELAY_MS;
  const graceMs = options.graceMs ?? PREFETCH_GRACE_MS;
  const ttlMs = options.ttlMs ?? PREFETCH_TTL_MS;
  const enabled = options.enabled ?? (() => true);
  const set = options.set ?? ((fn, ms) => setTimeout(fn, ms));
  const clear =
    options.clear ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = options.now ?? Date.now;
  const pending = new Map<string, Handle>();
  const done = new Map<string, Entry>();
  let destroyed = false;

  function letGo(entry: Entry) {
    if (entry.releaseTimer !== undefined) clear(entry.releaseTimer);
    entry.releaseTimer = undefined;
    const release = entry.release;
    entry.release = undefined;
    release?.();
  }

  function cancel(key: string) {
    const wait = pending.get(key);
    if (wait === undefined) return;
    clear(wait);
    pending.delete(key);
  }

  // Lets go of every key but `keep`, and drops the reads not yet started.
  function releaseExcept(keep?: string) {
    for (const key of [...pending.keys()]) if (key !== keep) cancel(key);
    for (const [key, entry] of done) if (key !== keep) letGo(entry);
  }

  return {
    enter(key: string) {
      if (destroyed || !enabled()) return;
      if (options.exclusive) releaseExcept(key);
      const known = done.get(key);
      if (known) {
        if (known.releaseTimer !== undefined) {
          clear(known.releaseTimer);
          known.releaseTimer = undefined;
        }
        if (known.release) return;
        if (!known.held && now() - known.at < ttlMs) return;
        done.delete(key);
      }
      if (pending.has(key)) return;
      pending.set(
        key,
        set(() => {
          pending.delete(key);
          if (destroyed || !enabled()) return;
          const release = options.start(key);
          done.set(key, { at: now(), release, held: release !== undefined });
        }, delayMs),
      );
    },

    leave(key: string) {
      cancel(key);
      const entry = done.get(key);
      if (entry?.release && entry.releaseTimer === undefined) {
        entry.releaseTimer = set(() => letGo(entry), graceMs);
      }
    },

    // The dialog opened on `key`: whatever the read held, the dialog holds now.
    opened(key: string) {
      cancel(key);
      const entry = done.get(key);
      if (entry) letGo(entry);
    },

    // Lets go of every key but `keep`; for a dialog about to open on it.
    releaseExcept,

    releaseAll() {
      releaseExcept();
    },

    // The page is going: nothing pending may start, nothing held may stay.
    destroy() {
      destroyed = true;
      releaseExcept();
    },
  };
}

type Intent = Pick<Warmer, 'enter' | 'leave'>;

// The last key pressed on the page, once one has been. A dialog that closes
// hands focus back to the control that opened it, and after a keyboard close
// that focus can match :focus-visible; but it follows Escape or Enter, never
// Tab, which is how a keyboard reaches a control. Null until a key is seen.
let lastKey: string | null = null;
let tracking = false;
export function noteKey(key: string) {
  lastKey = key;
}
function trackKeys() {
  if (tracking || typeof window === 'undefined') return;
  tracking = true;
  window.addEventListener('keydown', (e) => noteKey(e.key), true);
  // A pointer press ends the keyboard's turn.
  window.addEventListener('pointerdown', () => noteKey('pointer'), true);
}
// The part of an element this needs, so a test can stand in for it.
type Target = Pick<
  HTMLElement,
  'addEventListener' | 'removeEventListener' | 'matches'
>;

// Reports pointer hover and keyboard focus on `el`. A touch has no hover, and
// the focus a tap gives a button is not a keyboard reaching it, so neither
// reads anything early; nor does focus given by code after another key, as when a closed dialog
// hands focus back. Returns the cleanup.
export function intentOn(
  el: Target,
  warmer: Intent,
  key: () => string,
): () => void {
  trackKeys();
  let touched = false;
  const onDown = (event: Event) => {
    touched = (event as PointerEvent).pointerType === 'touch';
  };
  const onEnter = (event: Event) => {
    if ((event as PointerEvent).pointerType === 'touch') return;
    warmer.enter(key());
  };
  const onFocus = () => {
    const tap = touched;
    touched = false;
    if (tap || (lastKey !== null && lastKey !== 'Tab')) return;
    if (!el.matches(':focus-visible')) return;
    warmer.enter(key());
  };
  const onLeave = () => warmer.leave(key());
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointerenter', onEnter);
  el.addEventListener('focus', onFocus);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('blur', onLeave);
  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointerenter', onEnter);
    el.removeEventListener('focus', onFocus);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('blur', onLeave);
  };
}
