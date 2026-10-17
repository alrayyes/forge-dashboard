/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import {
  flushPendingSave,
  releaseAllHeld,
  type SharedFilterState,
  saveState,
} from './filters';

// Free text is saved to the server 500 ms after the last keystroke. Leaving the
// page inside that window used to drop the value from the server copy (#1620).
// Leaving flushes the pending save at once; the cookie is written on every
// keystroke already, so the next page load has it either way.
// https://github.com/alrayyes/forge-dashboard/issues/1620

const tick = () => new Promise<void>((r) => queueMicrotask(r));

type Sent = { body: SharedFilterState; keepalive: boolean; done: () => void };
let sent: Sent[] = [];
const realFetch = globalThis.fetch;
const fakeDoc = { cookie: '' };

beforeEach(() => {
  sent = [];
  releaseAllHeld();
  jest.useFakeTimers();
  Object.assign(globalThis, { document: fakeDoc });
  fakeDoc.cookie = '';
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      sent.push({
        body: JSON.parse(String(init?.body)),
        keepalive: init?.keepalive === true,
        done: () => resolve(new Response('{}')),
      });
    })) as typeof fetch;
});

afterEach(async () => {
  for (let i = 0; i < sent.length; i++) {
    sent[i].done();
    await tick();
    await tick();
  }
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  releaseAllHeld();
});

function typed(title: string): SharedFilterState {
  return { shared: {}, pr: { title }, issue: {}, view: {} };
}

describe('flushPendingSave', () => {
  test('sends the pending debounced save at once, with keepalive', () => {
    saveState(typed('fix'), 'title');
    expect(sent).toHaveLength(0);
    flushPendingSave();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.pr.title).toBe('fix');
    expect(sent[0].keepalive).toBe(true);
  });

  test('sends the latest value when several keystrokes are pending', () => {
    const s = typed('f');
    saveState(s, 'title');
    s.pr.title = 'fix';
    saveState(s, 'title');
    flushPendingSave();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.pr.title).toBe('fix');
  });

  test('sends nothing when nothing is pending', () => {
    flushPendingSave();
    expect(sent).toHaveLength(0);
  });

  test('the timer firing after a flush does not send a duplicate', () => {
    saveState(typed('fix'), 'title');
    flushPendingSave();
    jest.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });

  test('flushing twice sends once', () => {
    saveState(typed('fix'), 'title');
    flushPendingSave();
    flushPendingSave();
    expect(sent).toHaveLength(1);
  });

  test('a save already sent by its timer is not sent again', () => {
    saveState(typed('fix'), 'title');
    jest.advanceTimersByTime(500);
    expect(sent).toHaveLength(1);
    flushPendingSave();
    expect(sent).toHaveLength(1);
  });

  test('the cookie holds the latest value without any flush', () => {
    saveState(typed('fix'), 'title');
    expect(decodeURIComponent(fakeDoc.cookie)).toContain('"title":"fix"');
  });

  test('behind an in-flight PUT, the latest snapshot still goes out on flush', () => {
    saveState(typed(''));
    expect(sent).toHaveLength(1);
    saveState(typed('fix'), 'title');
    flushPendingSave();
    expect(sent).toHaveLength(2);
    expect(sent[1].body.pr.title).toBe('fix');
    expect(sent[1].keepalive).toBe(true);
  });

  test('a snapshot queued behind an in-flight PUT goes out on flush too', () => {
    saveState(typed(''));
    saveState(typed('fix'));
    expect(sent).toHaveLength(1);
    flushPendingSave();
    expect(sent).toHaveLength(2);
    expect(sent[1].body.pr.title).toBe('fix');
  });

  test('after a flush the in-flight finishing does not resend the queued one', async () => {
    saveState(typed(''));
    saveState(typed('fix'));
    flushPendingSave();
    sent[0].done();
    sent[1].done();
    await tick();
    await tick();
    await tick();
    expect(sent).toHaveLength(2);
  });
});
