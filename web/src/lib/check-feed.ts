// The job lists of the pull requests and branches a page has open ride the
// dashboard stream as named "checks" events. A page says which lists it wants
// by posting its watch, and the server sends one per subject on every change,
// so no board polls them or compares signatures to decide when to ask.

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
    type: 'open' | 'error' | 'checks',
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
  let open = false;
  let source: FeedSource | null = null;
  // Posts go one at a time, so a stale watch can't land after a newer one.
  let queue: Promise<unknown> = Promise.resolve();

  function tellAll(message: CheckFeedMessage) {
    for (const set of [...listeners.values()])
      for (const listener of [...set]) listener(message);
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
      next.addEventListener('open', () => {
        open = true;
        if (subjects.size > 0) send(false);
      });
      next.addEventListener('error', () => {
        if (next.readyState !== OPEN) open = false;
        tellAll({ error: DOWN });
      });
      next.addEventListener('checks', (event) => {
        let body: Subject & { checks?: Check[] | null; error?: string };
        try {
          body = JSON.parse(event.data ?? '');
        } catch {
          return;
        }
        const message: CheckFeedMessage = body.error
          ? { error: body.error }
          : { checks: body.checks ?? [] };
        for (const listener of [...(listeners.get(keyOf(body)) ?? [])])
          listener(message);
      });
    },

    // Wants the subject's list. Returns the unsubscribe.
    watch(subject: Subject, listener: Listener): () => void {
      const key = keyOf(subject);
      const set = listeners.get(key) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(key, set);
      const fresh = !subjects.has(key);
      subjects.set(key, subject);
      if (fresh) send(false);
      // A stream that is gone will never answer: say so rather than wait.
      if (!open && (!source || source.readyState === CLOSED))
        queueMicrotask(() => listener({ error: DOWN }));
      return () => {
        set.delete(listener);
        if (set.size > 0) return;
        listeners.delete(key);
        subjects.delete(key);
        send(false);
      };
    },

    // Asks the server to list the subject again, for when the page knows it
    // changed something. Resolves true once a fresh list arrives, false if it
    // failed or never came.
    refresh(subject: Subject): Promise<boolean> {
      const key = keyOf(subject);
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const listener: Listener = (message) => {
          clearTimeout(timer);
          listeners.get(key)?.delete(listener);
          resolve(!('error' in message));
        };
        const set = listeners.get(key) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(key, set);
        timer = setTimeout(() => {
          set.delete(listener);
          resolve(false);
        }, timeoutMs);
        send(true);
      });
    },
  };
}

// One feed for the page, shared by the stream owner that attaches it and the
// dialog that watches through it.
export const checkFeed = createCheckFeed();
