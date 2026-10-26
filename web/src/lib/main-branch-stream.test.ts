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
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const pages: MainBranches[] = [];
  let down = 0;
  const stop = followMainBranchPage({
    open: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    onPage: (page) => pages.push(page),
    onDown: () => down++,
    schedule: (fn, ms) => {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  });
  return { sources, timers, pages, stop, down: () => down };
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
    expect(h.timers).toEqual([]);
  });

  test('a closed stream asks for one fallback read and opens again later', () => {
    const h = harness();
    h.sources[0].fail();
    expect(h.down()).toBe(1);
    expect(h.timers.map((t) => t.ms)).toEqual([2000]);
    h.timers[0].fn();
    expect(h.sources).toHaveLength(2);
  });

  test('waits longer after each close, to a limit, and starts over once open', () => {
    const h = harness();
    for (let i = 0; i < 6; i++) {
      h.sources[i].fail();
      h.timers[i].fn();
    }
    expect(h.timers.map((t) => t.ms)).toEqual([
      2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    h.sources[6].onopen?.();
    h.sources[6].fail();
    expect(h.timers[6].ms).toBe(2000);
  });

  test('stopping closes the stream and cancels the reopen', () => {
    const h = harness();
    h.sources[0].fail();
    h.stop();
    expect(h.timers[0].live).toBe(false);
    expect(h.sources[0].closed).toBe(true);
  });
});
