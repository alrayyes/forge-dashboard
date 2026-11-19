// A pointer sweeping across several mentions should not read the forge once
// for each: only one it rests on for a moment is worth asking about (#4269).
// Focus and pointer-down are deliberate and skip this.
import { PREFETCH_DWELL_MS } from './details-cache';

export function createDwell<T>(
  fire: (subject: T) => void,
  delayMs = PREFETCH_DWELL_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let element: unknown;
  return {
    // The pointer is over `el`, which stands for `subject`. The same element
    // again keeps the wait already running.
    rest(el: unknown, subject: T) {
      if (timer && el === element) return;
      this.cancel();
      element = el;
      timer = setTimeout(() => {
        timer = undefined;
        element = undefined;
        fire(subject);
      }, delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      element = undefined;
    },
  };
}
