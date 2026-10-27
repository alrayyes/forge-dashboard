// The job lists of the pull requests and branches a page has open ride the
// dashboard stream as named "run" events, one for each workflow run attempt. A
// page says which lists it wants by posting its watch, and the server sends
// them again on every change, so no board polls them or decides when to ask.
// The page keeps the latest event for each run attempt and puts them together.

import type { Check } from './pipeline-checks';

export type Subject = {
  kind: 'pull_request' | 'main_branch';
  forge: string;
  fullName: string;
  number?: number;
};

// What a listener is told: the subject's job list, or why it has none.
export type CheckFeedMessage = { checks: Check[] } | { error: string };

type Listener = (message: CheckFeedMessage) => void;

// The part of an EventSource this needs, so a test can stand in for it.
export type FeedSource = {
  addEventListener(
    type: 'open' | 'error' | 'run',
    listener: (event: { data?: string }) => void,
  ): void;
  readyState: number;
};

type Options = {
  newId?: () => string;
  // Posts the watch body and answers the HTTP status.
  post?: (body: string) => Promise<number>;
  unauthorized?: () => void;
  // How long refresh() waits for the list before giving up.
  timeoutMs?: number;
};

const WATCH_URL = '/api/dashboard/stream/watch';
const DOWN = 'the live connection is down';
const SILENT = 'no answer from the server';
const OPEN = 1;
const CLOSED = 2;

const keyOf = (s: Subject) =>
  `${s.kind}|${s.forge}|${s.fullName}|${s.number ?? 0}`;

async function postWatch(body: string): Promise<number> {
  const response = await fetch(WATCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return response.status;
}

function toLogin() {
  window.location.href = '/login.html';
}

export function createCheckFeed({
  newId = () => crypto.randomUUID(),
  post = postWatch,
  unauthorized = toLogin,
  timeoutMs = 10000,
}: Options = {}) {
  const streamId = newId();
  const subjects = new Map<string, Subject>();
  const listeners = new Map<string, Set<Listener>>();
  // Refreshes waiting on an answer, apart from the dialogs that watch: a
  // dialog closing must not look like a watcher still there.
  const waiters = new Map<string, Set<Listener>>();
  // The latest event of each run attempt, by subject and then by the key the
  // server gave the attempt. A rerun has a new key and the old one goes.
  const runs = new Map<string, Map<string, Check[]>>();
  let open = false;
  let source: FeedSource | null = null;
  // Posts go one at a time, so a stale watch can't land after a newer one.
  let queue: Promise<unknown> = Promise.resolve();

  function tellAll(message: CheckFeedMessage) {
    for (const map of [listeners, waiters])
      for (const set of [...map.values()])
        for (const listener of [...set]) listener(message);
  }

  function tell(key: string, message: CheckFeedMessage) {
    for (const map of [listeners, waiters])
      for (const listener of [...(map.get(key) ?? [])]) listener(message);
  }

  // A stream that closed for good will not answer. One not attached yet
  // may: the page opens it after its tools and dialogs are ready.
  function unavailable() {
    return !open && source?.readyState === CLOSED;
  }

  function send(refresh: boolean) {
    if (!open) return;
    const body = JSON.stringify({
      streamId,
      subjects: [...subjects.values()],
      ...(refresh ? { refresh: true } : {}),
    });
    queue = queue.then(async () => {
      let status = 0;
      try {
        status = await post(body);
      } catch {
        // Treated as a refusal below.
      }
      if (status === 401) unauthorized();
      else if (status !== 204) tellAll({ error: DOWN });
    });
  }

  return {
    // The stream URL with this feed's id on it, so the server can tell which
    // connection a watch is for.
    streamUrl(url: string): string {
      return `${url}${url.includes('?') ? '&' : '?'}sid=${streamId}`;
    },

    // Follows the stream's events. The server forgets a watch when its
    // stream goes, so the watch is posted again on every open.
    attach(next: FeedSource) {
      source = next;
      open = next.readyState === OPEN;
      if (open && subjects.size > 0) send(false);
      next.addEventListener('open', () => {
        open = true;
        if (subjects.size > 0) send(false);
      });
      next.addEventListener('error', () => {
        if (next.readyState !== OPEN) open = false;
        tellAll({ error: DOWN });
      });
      next.addEventListener('run', (event) => {
        let body: Subject & {
          key?: string;
          checks?: Check[] | null;
          gone?: boolean;
          final?: boolean;
          error?: string;
        };
        try {
          body = JSON.parse(event.data ?? '');
        } catch {
          return;
        }
        const subject = keyOf(body);
        if (body.error) {
          tell(subject, { error: body.error });
          return;
        }
        const held = runs.get(subject) ?? new Map<string, Check[]>();
        runs.set(subject, held);
        if (!body.key) held.clear();
        else if (body.gone) held.delete(body.key);
        else held.set(body.key, body.checks ?? []);
        // A listing is told once, at its last event, so a page is not
        // redrawn for every run in it.
        if (body.final) tell(subject, { checks: [...held.values()].flat() });
      });
    },

    // Wants the subject's list. Returns the unsubscribe.
    watch(subject: Subject, follower: Listener): () => void {
      const key = keyOf(subject);
      const set = listeners.get(key) ?? new Set<Listener>();
      // A stream still connecting is not closed, so nothing says it won't
      // answer. Say so after a bounded wait; a list that comes later still
      // gets through.
      const timer = setTimeout(() => follower({ error: SILENT }), timeoutMs);
      const listener: Listener = (message) => {
        clearTimeout(timer);
        follower(message);
      };
      set.add(listener);
      listeners.set(key, set);
      const fresh = !subjects.has(key);
      subjects.set(key, subject);
      if (fresh) send(false);
      // A list can't come without a stream, so say so rather than wait.
      if (unavailable())
        void Promise.resolve().then(() => listener({ error: DOWN }));
      return () => {
        clearTimeout(timer);
        set.delete(listener);
        if (set.size > 0) return;
        listeners.delete(key);
        subjects.delete(key);
        runs.delete(key);
        send(false);
      };
    },

    // Asks the server to list the subject again, for when the page knows it
    // changed something. Resolves true once a fresh list arrives, false if it
    // failed or never came.
    async refresh(subject: Subject): Promise<boolean> {
      if (unavailable()) return false;
      const key = keyOf(subject);
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const listener: Listener = (message) => {
          clearTimeout(timer);
          waiters.get(key)?.delete(listener);
          resolve(!('error' in message));
        };
        const set = waiters.get(key) ?? new Set<Listener>();
        set.add(listener);
        waiters.set(key, set);
        timer = setTimeout(() => {
          set.delete(listener);
          resolve(false);
        }, timeoutMs);
        send(true);
      });
    },

    // The subject's list once, for a caller that wants the answer rather than
    // to follow it. Watches the subject for as long as the answer takes.
    read(subject: Subject): Promise<CheckFeedMessage> {
      if (unavailable()) return Promise.resolve({ error: DOWN });
      const watched = subjects.has(keyOf(subject));
      return new Promise((resolve) => {
        let stop = () => {};
        const finish = (message: CheckFeedMessage) => {
          clearTimeout(timer);
          stop();
          resolve(message);
        };
        const timer = setTimeout(() => finish({ error: SILENT }), timeoutMs);
        stop = this.watch(subject, finish);
        // Already watched, so nothing new is sent unless asked for.
        if (watched) send(true);
      });
    },
  };
}

// One feed for the page, shared by the stream owner that attaches it and the
// dialog that watches through it.
export const checkFeed = createCheckFeed();
