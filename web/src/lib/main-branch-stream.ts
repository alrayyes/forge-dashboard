// The Main branches page follows the dashboard stream like the other pages:
// each message carries the page's rows as `mainBranchPage`, and the page keeps
// no poll of its own (#2884). GET /api/main-branches is the one fallback read,
// asked for when the stream is down and again when it comes back, since the
// server sends nothing on connect and a change in the gap would stay unseen.

import { checkFeed, type FeedSource } from './check-feed';
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
// A stream that has not opened by then sits behind something that buffers it.
const CONNECT_MS = 30000;
// Streams in a row that never opened, after which the page stops trying, as
// the other pages do.
const FAILURE_LIMIT = 5;

type Follow = {
  open?: () => StreamSource;
  onPage: (page: MainBranches) => void;
  // The stream closed: read the page once, as the fallback.
  onDown: () => void;
  // The stream opened again after being down: read the page once, for what
  // changed in the gap.
  onUp: () => void;
  schedule?: (fn: () => void, ms: number) => () => void;
};

function openDashboardStream(): StreamSource {
  // An EventSource passes its handlers an event; these take none they use.
  const source = new EventSource(checkFeed.streamUrl('/api/dashboard/stream'));
  // The job lists of an open pipeline dialog ride this stream too.
  checkFeed.attach(source as unknown as FeedSource);
  return source as unknown as StreamSource;
}

function scheduleTimeout(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

// Opens the stream and hands each page to onPage. A stream that closed (the
// server answers 404 until it runs a refresh for the user, and EventSource
// never retries a non-200) is opened again after a wait that doubles, from 2s,
// and starts over once a connection opens. Returns the cleanup.
export function followMainBranchPage({
  open = openDashboardStream,
  onPage,
  onDown,
  onUp,
  schedule = scheduleTimeout,
}: Follow): () => void {
  let source: StreamSource | null = null;
  let cancelRetry: (() => void) | null = null;
  let retryMs = RETRY_MIN_MS;
  let stopped = false;
  let failures = 0;
  let wasDown = false;

  function connect() {
    cancelRetry = null;
    if (stopped) return;
    const next = open();
    source = next;
    const cancelWatchdog = schedule(() => {
      if (next !== source) return;
      next.close();
      fail(next);
    }, CONNECT_MS);
    next.onopen = () => {
      cancelWatchdog();
      retryMs = RETRY_MIN_MS;
      failures = 0;
      if (wasDown) onUp();
      wasDown = false;
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
      // Not closed means the browser is retrying on its own. It reopens the
      // same stream, so the gap still needs a catch-up read on open.
      if (next.readyState !== CLOSED) {
        wasDown = true;
        return;
      }
      cancelWatchdog();
      fail(next);
    };
  }

  function fail(from: StreamSource) {
    if (from !== source || stopped) return;
    wasDown = true;
    failures++;
    onDown();
    if (failures >= FAILURE_LIMIT) return;
    cancelRetry = schedule(connect, retryMs);
    retryMs *= 2;
  }

  connect();
  return () => {
    stopped = true;
    cancelRetry?.();
    source?.close();
  };
}
