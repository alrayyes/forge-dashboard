// What the pull request and issue dialog read last, kept in this tab so the
// next open shows it at once while a quiet read swaps in the fresh answer
// (#4194). Nothing here is persisted: a reload starts empty.

export type DetailsRef = {
  forge: string;
  repo: string;
  subject: 'pull-request' | 'issue';
  number: number;
};

export type DetailsEntry<T> = {
  details: T;
  // When the forge was read, in epoch milliseconds.
  readAt: number;
  // The markdown rendered from `details`, when the dialog has done it.
  html?: Record<string, string>;
};

export const detailsKey = (ref: DetailsRef): string =>
  `${ref.forge}|${ref.repo}|${ref.subject}|${ref.number}`;

export const detailsUrl = (ref: DetailsRef): string =>
  `/api/v1/${ref.subject === 'issue' ? 'issues' : 'pull-requests'}/details` +
  `?forge=${encodeURIComponent(ref.forge)}` +
  `&fullName=${encodeURIComponent(ref.repo)}&number=${ref.number}`;

export type DetailsCache<T> = {
  get(key: string): DetailsEntry<T> | undefined;
  set(key: string, entry: DetailsEntry<T>): void;
  delete(key: string): void;
  clear(): void;
  size(): number;
  // Bumped by every delete, so a read that began before one can tell.
  generation(): number;
};

// A Map keeps insertion order, so the first key is the least recently used
// once `get` re-inserts what it returns.
export function createDetailsCache<T>(max = 40): DetailsCache<T> {
  const entries = new Map<string, DetailsEntry<T>>();
  let generation = 0;
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry) {
        entries.delete(key);
        entries.set(key, entry);
      }
      return entry;
    },
    set(key, entry) {
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    delete(key) {
      generation++;
      entries.delete(key);
    },
    clear() {
      generation++;
      entries.clear();
    },
    size: () => entries.size,
    generation: () => generation,
  };
}

export const PREFETCH_DWELL_MS = 150;

type Timer = ReturnType<typeof setTimeout>;

// Starts the read for a row the pointer or focus has stayed on for the dwell.
// Leaving cancels it, so moving across a list reads nothing.
export function createPrefetcher<T>(opts: {
  cache: DetailsCache<T>;
  load: (ref: DetailsRef) => Promise<T>;
  delayMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer | number;
  clearTimer?: (id: Timer | number) => void;
}) {
  const delay = opts.delayMs ?? PREFETCH_DWELL_MS;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as Timer));
  const inFlight = new Set<string>();
  let pending: Timer | number | null = null;

  const cancel = () => {
    if (pending !== null) clearTimer(pending);
    pending = null;
  };

  const start = (ref: DetailsRef) => {
    const key = detailsKey(ref);
    if (opts.cache.get(key) || inFlight.has(key)) return;
    inFlight.add(key);
    const generation = opts.cache.generation();
    opts
      .load(ref)
      .then((details) => {
        // A user action cleared this entry while the read was out: what came
        // back may predate it.
        if (opts.cache.generation() !== generation) return;
        if (opts.cache.get(key)) return;
        opts.cache.set(key, { details, readAt: now() });
      })
      .catch(() => {})
      .finally(() => inFlight.delete(key));
  };

  return {
    enter(ref: DetailsRef) {
      cancel();
      pending = setTimer(() => {
        pending = null;
        start(ref);
      }, delay);
    },
    leave: cancel,
  };
}

// The page's one cache and prefetcher. The dialog fills the cache with what
// it rendered; a row's hover or focus fills it with the bare answer.
export const detailsCache = createDetailsCache<unknown>();

export const detailsPrefetcher = createPrefetcher<unknown>({
  cache: detailsCache,
  load: async (ref) => {
    const res = await fetch(detailsUrl(ref), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`details ${res.status}`);
    return res.json();
  },
});
