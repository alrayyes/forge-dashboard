// A mention of an item in a repository the dashboard does not track stays a
// forge link, and its dialog is a shortcut (#4269). The forge is asked while
// the pointer or focus rests on the link, and a click opens the dialog only
// when that answer is already in. Any other click follows the link as it is,
// to the forge in a new tab: no tab is opened from script, so no browser
// blocks it, and nothing waits.

export type Reference = { forge: string; repo: string; number: number };

export type PrefetchDeps = {
  probe: (ref: Reference) => Promise<unknown | null>;
  // The details of this item are already read (and kept for the dialog).
  isKnown: (ref: Reference) => boolean;
  remember: (ref: Reference, details: unknown) => void;
  now?: () => number;
};

// After a failed lookup the forge is left alone for this long.
export const RETRY_AFTER_MS = 30_000;

export function createReferencePrefetcher(deps: PrefetchDeps) {
  const now = deps.now ?? Date.now;
  const waiting = new Map<string, Promise<void>>();
  const failedAt = new Map<string, number>();
  const keyOf = (r: Reference) => `${r.forge}|${r.repo}|${r.number}`;

  return {
    isReady: (ref: Reference): boolean => deps.isKnown(ref),
    warm(ref: Reference): Promise<void> {
      if (deps.isKnown(ref)) return Promise.resolve();
      const key = keyOf(ref);
      const running = waiting.get(key);
      if (running) return running;
      const failed = failedAt.get(key);
      if (failed !== undefined && now() - failed < RETRY_AFTER_MS)
        return Promise.resolve();
      const run = deps
        .probe(ref)
        .then((found) => {
          if (found === null) failedAt.set(key, now());
          else {
            failedAt.delete(key);
            deps.remember(ref, found);
          }
        })
        .finally(() => waiting.delete(key));
      waiting.set(key, run);
      return run;
    },
  };
}
