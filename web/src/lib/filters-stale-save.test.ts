/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import {
  flushPendingSave,
  loadState,
  releaseAllHeld,
  saveState,
} from './filters';

// The server ignores a save older than its copy and answers 200 with the copy's
// revision. The page takes that revision, then sends the edit again, once.

const fakeDoc = { cookie: '' };
const realFetch = globalThis.fetch;
let puts: Record<string, unknown>[] = [];
let answers: Response[] = [];

beforeEach(() => {
  releaseAllHeld();
  jest.useFakeTimers();
  Object.assign(globalThis, { document: fakeDoc });
  fakeDoc.cookie = '';
  puts = [];
  answers = [];
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)));
      return Promise.resolve(
        answers.shift() ?? new Response(null, { status: 204 }),
      );
    }
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('a save the server ignores as older', () => {
  test('is sent again once, past the revision the server holds', async () => {
    answers = [
      new Response(JSON.stringify({ rev: 500 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ];
    const state = loadState();
    state.pr.title = 'billing';
    saveState(state);
    await settle();

    expect(puts).toHaveLength(2);
    expect(puts[1].rev as number).toBeGreaterThan(500);
    expect((puts[1].pr as { title: string }).title).toBe('billing');
  });

  test('is not sent a third time if the server ignores the resend as well', async () => {
    const ignored = () =>
      new Response(JSON.stringify({ rev: 900 }), { status: 200 });
    answers = [ignored(), ignored(), ignored()];
    saveState(loadState());
    await settle();

    expect(puts).toHaveLength(2);
  });

  test('a stored save (204) is not sent again', async () => {
    saveState(loadState());
    await settle();

    expect(puts).toHaveLength(1);
  });
});

describe('a flush beside a save in flight that the server ignores as older', () => {
  test('is sent again, past the revision the server holds', async () => {
    const waiting: Array<(res: Response) => void> = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      if (init?.method !== 'PUT') return Promise.resolve(new Response('{}'));
      puts.push(JSON.parse(String(init.body)));
      return new Promise<Response>((resolve) => waiting.push(resolve));
    }) as typeof fetch;

    const state = loadState();
    saveState(state);
    state.pr.title = 'billing';
    saveState(state, 'title');
    flushPendingSave();
    expect(puts).toHaveLength(2);

    // The flush is answered first: the server holds a newer copy.
    waiting[1](new Response(JSON.stringify({ rev: 500 }), { status: 200 }));
    await settle();

    expect(puts).toHaveLength(3);
    expect(puts[2].rev as number).toBeGreaterThan(500);
    expect((puts[2].pr as { title: string }).title).toBe('billing');

    // Let every request finish, or the save left in flight leaks into the
    // next test file.
    for (let i = 0; i < 5; i++) {
      for (const done of waiting) done(new Response(null, { status: 204 }));
      await settle();
    }
  });
});
