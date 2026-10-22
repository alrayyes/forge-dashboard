/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  applyServerState,
  loadState,
  releaseAllHeld,
  type SharedFilterState,
  saveState,
  setSaveRefusedHandler,
} from './filters';
import {
  MAX_ENCODED,
  MAX_LABELS,
  parseLabels,
  toggleLabel,
} from './label-filter';

// A saved Label filter over the limits the server enforces (20 labels, 1000
// characters) used to load as it was, and every later save came back 400 and
// was dropped without a word. The page now trims such a value as it loads, and
// says so when the server still refuses a save.
// https://github.com/alrayyes/forge-dashboard/issues/2100

const tick = () => new Promise((r) => setTimeout(r, 0));
const realFetch = globalThis.fetch;
const many = (n: number) =>
  Array.from({ length: n }, (_, i) => `label-${i}`).join('\n');
const blank = (): SharedFilterState => ({
  shared: {},
  pr: {},
  issue: {},
  view: {},
});

let puts: SharedFilterState[] = [];
let status = 200;
let refused = 0;

beforeEach(() => {
  puts = [];
  status = 200;
  refused = 0;
  releaseAllHeld();
  Object.assign(globalThis, { document: { cookie: '' } });
  setSaveRefusedHandler(() => {
    refused++;
  });
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    puts.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response('{}', { status }));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setSaveRefusedHandler(null);
  releaseAllHeld();
});

function seedCookie(label: string) {
  const value = JSON.stringify({ shared: { label, author: 'ryan' }, rev: 1 });
  Object.assign(globalThis, {
    document: { cookie: `forge-board-filters=${encodeURIComponent(value)}` },
  });
}

describe('a saved label pick over the limits', () => {
  test('is trimmed to 20 labels when the cookie loads, and the next save is within them', async () => {
    seedCookie(many(25));
    const state = loadState();
    expect(parseLabels(state.shared.label)).toHaveLength(MAX_LABELS);
    saveState(state);
    await tick();
    expect(puts[0].shared.label.split('\n')).toHaveLength(MAX_LABELS);
  });

  test('is trimmed to 1000 characters when the cookie loads', () => {
    seedCookie(
      Array.from({ length: 10 }, (_, i) => `${i}`.repeat(150)).join('\n'),
    );
    const state = loadState();
    expect([...(state.shared.label ?? '')].length).toBeLessThanOrEqual(1000);
    expect(state.shared.author).toBe('ryan');
  });

  test('is trimmed when the server copy brings it', () => {
    const state = blank();
    applyServerState(state, { shared: { label: many(25) } });
    expect(state.shared.label?.split('\n')).toHaveLength(MAX_LABELS);
  });
});

describe('a refused filter save', () => {
  test('tells the page once and does not try again by itself', async () => {
    status = 400;
    saveState(blank());
    await tick();
    await tick();
    expect(puts).toHaveLength(1);
    expect(refused).toBe(1);
  });

  test('says nothing when the server accepts it', async () => {
    saveState(blank());
    await tick();
    expect(refused).toBe(0);
  });

  test('the next pick is still sent after a refusal', async () => {
    status = 400;
    saveState(blank());
    await tick();
    status = 200;
    saveState(blank());
    await tick();
    expect(puts).toHaveLength(2);
  });
});

describe('labels in a multibyte script', () => {
  // Twenty labels of 40 characters: under the 1000-character cap, but 120
  // bytes each, and nine times the characters once percent-encoded.
  const names = Array.from({ length: 20 }, (_, i) =>
    `标签${i}`.padEnd(40, '签'),
  );

  test('stop being added before the encoded pick passes the cookie budget', () => {
    let picked: string[] = [];
    for (const name of names) picked = toggleLabel(picked, name);
    const encoded = encodeURIComponent(JSON.stringify(picked.join('\n')));
    expect(picked.length).toBeLessThan(names.length);
    expect(encoded.length).toBeLessThanOrEqual(MAX_ENCODED);
  });

  test('a saved pick over the budget is trimmed when it loads', () => {
    seedCookie(names.join('\n'));
    const state = loadState();
    const encoded = encodeURIComponent(JSON.stringify(state.shared.label));
    expect(encoded.length).toBeLessThanOrEqual(MAX_ENCODED);
  });
});

// Label, Repo and Author share the one filter cookie, so the three picks
// together, not each alone, have to fit what a browser keeps of it.
describe('the three picks together stay inside the cookie', () => {
  const multibyte = (tag: string) =>
    Array.from({ length: 20 }, (_, i) => `${tag}${i}`.padEnd(60, '日'));

  test('full picks of all three are cut so the saved cookie keeps room for the rest', () => {
    const value = JSON.stringify({
      shared: {
        label: multibyte('l').join('\n'),
        repo: multibyte('github:r').join('\n'),
        author: multibyte('a').join('\n'),
      },
      rev: 1,
    });
    Object.assign(globalThis, {
      document: { cookie: `forge-board-filters=${encodeURIComponent(value)}` },
    });
    const state = loadState();
    saveState(state);
    const written = String(
      (globalThis as unknown as { document: { cookie: string } }).document
        .cookie,
    );
    const nameAndValue = written.split(';')[0];
    // 4096 is what a browser keeps; 500 is left for the other filters.
    expect(nameAndValue.length).toBeLessThanOrEqual(3600);
  });
});
