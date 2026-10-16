/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { releaseAllHeld, type SharedFilterState, saveState } from './filters';

// Two picks in quick succession send two PUTs. The server keeps whichever
// lands last, and two requests in flight can land in either order, so an older
// pick could overwrite the newer one (#1637). Saves go one at a time and the
// last snapshot is always the last one sent.
// https://github.com/alrayyes/forge-dashboard/issues/1637

const tick = () => new Promise((r) => setTimeout(r, 0));

type Sent = { body: SharedFilterState; done: () => void };
let sent: Sent[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  releaseAllHeld();
  Object.assign(globalThis, { document: { cookie: '' } });
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      sent.push({
        body: JSON.parse(String(init?.body)),
        done: () => resolve(new Response('{}')),
      });
    })) as typeof fetch;
});

afterEach(async () => {
  // The saver is module state: finish whatever is still out so the next test
  // (here or in another file) starts with nothing in flight.
  for (let i = 0; i < sent.length; i++) {
    sent[i].done();
    await tick();
  }
  globalThis.fetch = realFetch;
  releaseAllHeld();
});

function pick(author: string, label: string): SharedFilterState {
  return { shared: { author, label }, pr: {}, issue: {}, view: {} };
}

describe('saveState ordering', () => {
  test('does not start a second PUT while the first is in flight', async () => {
    saveState(pick('ryan', ''));
    saveState(pick('ryan', 'bug'));
    await tick();
    expect(sent).toHaveLength(1);
  });

  test('sends the latest snapshot once the first PUT finishes', async () => {
    saveState(pick('ryan', ''));
    saveState(pick('ryan', 'bug'));
    sent[0].done();
    await tick();
    expect(sent).toHaveLength(2);
    expect(sent[1].body.shared).toEqual({ author: 'ryan', label: 'bug' });
  });

  test('coalesces several picks made while one is in flight', async () => {
    saveState(pick('', ''));
    saveState(pick('ryan', ''));
    saveState(pick('ryan', 'bug'));
    sent[0].done();
    await tick();
    sent[1].done();
    await tick();
    expect(sent).toHaveLength(2);
    expect(sent[1].body.shared.label).toBe('bug');
  });

  test('keeps saving after a PUT fails', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    saveState(pick('ryan', ''));
    await tick();
    globalThis.fetch = ((_u: string, init?: RequestInit) => {
      sent.push({ body: JSON.parse(String(init?.body)), done: () => {} });
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;
    saveState(pick('ryan', 'bug'));
    await tick();
    expect(sent).toHaveLength(1);
  });

  test('sends the queued snapshot when the in-flight PUT fails', async () => {
    const bodies: SharedFilterState[] = [];
    let calls = 0;
    globalThis.fetch = ((_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      calls++;
      return calls === 1
        ? new Promise<Response>((_, reject) => {
            failFirst = () => reject(new Error('offline'));
          })
        : Promise.resolve(new Response('{}'));
    }) as typeof fetch;
    let failFirst = () => {};
    saveState(pick('ryan', ''));
    saveState(pick('ryan', 'bug'));
    failFirst();
    await tick();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].shared).toEqual({ author: 'ryan', label: 'bug' });
  });

  test('a PUT that never settles is aborted and later saves go out', async () => {
    jest.useFakeTimers();
    try {
      const bodies: SharedFilterState[] = [];
      const signals: (AbortSignal | null | undefined)[] = [];
      globalThis.fetch = ((_u: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        signals.push(init?.signal);
        if (bodies.length > 1) return Promise.resolve(new Response('{}'));
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        );
      }) as typeof fetch;
      saveState(pick('ryan', ''));
      saveState(pick('ryan', 'bug'));
      expect(bodies).toHaveLength(1);
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(signals[0]?.aborted).toBe(true);
      expect(bodies).toHaveLength(2);
      expect(bodies[1].shared.label).toBe('bug');
    } finally {
      jest.useRealTimers();
    }
  });
});
