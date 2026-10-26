/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { followMainBranchPage, type StreamSource } from './main-branch-stream';
import type { MainBranches } from './main-branches';

// The Main branches page takes its rows from the dashboard stream, like the
// other pages, and reads GET /api/main-branches only when the stream is down.

class FakeSource implements StreamSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  closed = false;
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  send(data: unknown) {
    this.onmessage?.({
      data: typeof data === 'string' ? data : JSON.stringify(data),
    });
  }
  fail() {
    this.readyState = 2;
    this.onerror?.();
  }
}

function harness() {
  const sources: FakeSource[] = [];
  const timers: {
    fn: () => void;
    ms: number;
    live: boolean;
    watchdog: boolean;
  }[] = [];
  // The watchdog is the timer asked for right after a stream is opened.
  let opening = false;
  const pages: MainBranches[] = [];
  let down = 0;
  let up = 0;
  const stop = followMainBranchPage({
    open: () => {
      const source = new FakeSource();
      sources.push(source);
      opening = true;
      return source;
    },
    onPage: (page) => pages.push(page),
    onDown: () => down++,
    onUp: () => up++,
    schedule: (fn, ms) => {
      const timer = {
        fn: () => {
          timer.live = false;
          fn();
        },
        ms,
        live: true,
        watchdog: opening,
      };
      opening = false;
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  });
  const retries = () => timers.filter((t) => !t.watchdog);
  return {
    sources,
    timers,
    retries,
    pages,
    stop,
    down: () => down,
    up: () => up,
  };
}

const PAGE = { generatedAt: 'now', counts: {}, forges: [], branches: [] };

describe('followMainBranchPage', () => {
  test('hands over the page a stream message carries', () => {
    const h = harness();
    h.sources[0].send({ mainBranchPage: PAGE, pullRequests: [] });
    expect(h.pages).toEqual([PAGE as unknown as MainBranches]);
  });

  test('ignores a message without the page, and one that is not JSON', () => {
    const h = harness();
    h.sources[0].send({ pullRequests: [] });
    h.sources[0].send('not json');
    expect(h.pages).toEqual([]);
  });

  test('a connection the browser is retrying itself is left alone', () => {
    const h = harness();
    h.sources[0].onerror?.();
    expect(h.down()).toBe(0);
    expect(h.retries()).toEqual([]);
  });

  test('reads once when the browser reconnects a stream by itself', () => {
    const h = harness();
    h.sources[0].onopen?.();
    h.sources[0].onerror?.();
    h.sources[0].onopen?.();
    expect(h.up()).toBe(1);
  });

  test('a closed stream asks for one fallback read and opens again later', () => {
    const h = harness();
    h.sources[0].fail();
    expect(h.down()).toBe(1);
    expect(h.retries().map((t) => t.ms)).toEqual([2000]);
    h.retries()[0].fn();
    expect(h.sources).toHaveLength(2);
  });

  test('waits longer after each close, and starts over once open', () => {
    const h = harness();
    for (let i = 0; i < 4; i++) {
      h.sources[i].fail();
      h.retries()[i].fn();
    }
    expect(h.retries().map((t) => t.ms)).toEqual([2000, 4000, 8000, 16000]);
    h.sources[4].onopen?.();
    h.sources[4].fail();
    expect(h.retries()[4].ms).toBe(2000);
  });

  test('stopping closes the stream and cancels the reopen', () => {
    const h = harness();
    h.sources[0].fail();
    h.stop();
    expect(h.retries()[0].live).toBe(false);
    expect(h.sources[0].closed).toBe(true);
  });

  test('reads again when the stream opens after being down', () => {
    const h = harness();
    h.sources[0].fail();
    h.retries()[0].fn();
    h.sources[1].onopen?.();
    expect(h.up()).toBe(1);
  });

  test('does not read again for the first open', () => {
    const h = harness();
    h.sources[0].onopen?.();
    expect(h.up()).toBe(0);
  });

  test('a stream still connecting after 30 seconds counts as down', () => {
    const h = harness();
    const watchdog = h.timers.find((t) => t.watchdog);
    watchdog?.fn();
    expect(h.down()).toBe(1);
    expect(h.sources[0].closed).toBe(true);
    expect(h.retries().some((t) => t.live && t.ms === 2000)).toBe(true);
  });

  test('a stream that opened is not taken for down by the watchdog', () => {
    const h = harness();
    h.sources[0].onopen?.();
    const watchdog = h.timers.find((t) => t.watchdog);
    expect(watchdog?.live).toBe(false);
  });

  test('gives up after five streams in a row fail to open', () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.sources[i].fail();
      h.retries()
        .findLast((t) => t.live)
        ?.fn();
    }
    expect(h.sources).toHaveLength(5);
    expect(h.retries().some((t) => t.live)).toBe(false);
    expect(h.down()).toBe(5);
  });
});
