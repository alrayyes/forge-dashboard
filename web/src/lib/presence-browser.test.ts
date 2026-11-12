/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { startPresence } from './presence-browser';

// The wiring around presence.ts: the real document, window and fetch. The
// state machine is covered in presence.test.ts; this proves the page reports
// visible on start, hidden when the tab hides, visible when it comes back,
// under one viewer id.

type Report = { viewerId: string; visible: boolean };

const realFetch = globalThis.fetch;
const realDocument = globalThis.document;
const realWindow = (globalThis as Record<string, unknown>).window;
const realAddEventListener = (globalThis as Record<string, unknown>)
  .addEventListener;
let reports: Report[] = [];
let state: 'visible' | 'hidden' = 'visible';
let docHandlers: Record<string, () => void> = {};
let stop: (() => void) | null = null;

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  reports = [];
  state = 'visible';
  docHandlers = {};
  const win = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: number) => clearTimeout(h),
  };
  Object.assign(globalThis, {
    window: win,
    document: {
      addEventListener: (name: string, fn: () => void) => {
        docHandlers[name] = fn;
      },
      removeEventListener: () => {},
      get visibilityState() {
        return state;
      },
    },
    fetch: async (_url: string, init?: RequestInit) => {
      reports.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ heartbeatSeconds: 3600, idleAfterSeconds: 0 }),
        { status: 200 },
      );
    },
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  Object.assign(globalThis, {
    fetch: realFetch,
    document: realDocument,
    window: realWindow,
    addEventListener: realAddEventListener,
  });
});

test('a tab reports visible, then hidden, then visible again, under one id', async () => {
  stop = startPresence();
  await settle();
  expect(reports.map((r) => r.visible)).toEqual([true]);

  state = 'hidden';
  docHandlers.visibilitychange();
  await settle();
  expect(reports.map((r) => r.visible)).toEqual([true, false]);

  state = 'visible';
  docHandlers.visibilitychange();
  await settle();
  expect(reports.map((r) => r.visible)).toEqual([true, false, true]);
  expect(new Set(reports.map((r) => r.viewerId)).size).toBe(1);
});
