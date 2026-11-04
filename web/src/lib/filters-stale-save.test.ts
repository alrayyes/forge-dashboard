/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { loadState, releaseAllHeld, saveState } from './filters';

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
