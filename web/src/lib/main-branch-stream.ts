// The Main branches page follows the dashboard stream like the other pages:
// each message carries the page's rows as `mainBranchPage`, and the page keeps
// no poll of its own (#2884). GET /api/main-branches is the one fallback read,
// asked for when the stream closes.

import type { MainBranches } from './main-branches';

// The part of an EventSource this needs, so a test can stand in for it.
export type StreamSource = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  close(): void;
};

const CLOSED = 2;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30000;

type Follow = {
  open?: () => StreamSource;
  onPage: (page: MainBranches) => void;
  // The stream closed: read the page once, as the fallback.
  onDown: () => void;
  schedule?: (fn: () => void, ms: number) => () => void;
};

function openDashboardStream(): StreamSource {
  // An EventSource passes its handlers an event; these take none they use.
  return new EventSource('/api/dashboard/stream') as unknown as StreamSource;
}

function scheduleTimeout(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

// Opens the stream and hands each page to onPage. A stream that closed (the
// server answers 404 until it runs a refresh for the user, and EventSource
// never retries a non-200) is opened again after a wait that doubles to a
// limit and starts over once a connection opens. Returns the cleanup.
export function followMainBranchPage({
  open = openDashboardStream,
  onPage,
  onDown,
  schedule = scheduleTimeout,
}: Follow): () => void {
  let source: StreamSource | null = null;
  let cancelRetry: (() => void) | null = null;
  let retryMs = RETRY_MIN_MS;
  let stopped = false;

  function connect() {
    cancelRetry = null;
    if (stopped) return;
    const next = open();
    source = next;
    next.onopen = () => {
      retryMs = RETRY_MIN_MS;
    };
    next.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message?.mainBranchPage) onPage(message.mainBranchPage);
      } catch {
        // A malformed event is not worth surfacing; the next one replaces it.
      }
    };
    next.onerror = () => {
      // Not closed means the browser is retrying on its own.
      if (next !== source || next.readyState !== CLOSED) return;
      onDown();
      cancelRetry = schedule(connect, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };
  }

  connect();
  return () => {
    stopped = true;
    cancelRetry?.();
    source?.close();
  };
}
