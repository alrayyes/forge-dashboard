import { describe, expect, test } from 'bun:test';
import { createDwell } from './reference-dwell';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createDwell', () => {
  test('fires once after the pointer rests on a subject', async () => {
    const fired: string[] = [];
    const dwell = createDwell<string>((s) => fired.push(s), 10);
    dwell.rest('a', 'a');
    expect(fired).toEqual([]);
    await wait(30);
    expect(fired).toEqual(['a']);
  });

  test('moving on to another subject first fires only the last', async () => {
    const fired: string[] = [];
    const dwell = createDwell<string>((s) => fired.push(s), 20);
    dwell.rest('a', 'a');
    dwell.rest('b', 'b');
    dwell.rest('c', 'c');
    await wait(50);
    expect(fired).toEqual(['c']);
  });

  test('resting again on the same element does not restart the wait', async () => {
    const fired: string[] = [];
    const dwell = createDwell<string>((s) => fired.push(s), 30);
    const el = {};
    dwell.rest(el, 'a');
    await wait(20);
    dwell.rest(el, 'a');
    await wait(20);
    expect(fired).toEqual(['a']);
  });

  test('leaving cancels it', async () => {
    const fired: string[] = [];
    const dwell = createDwell<string>((s) => fired.push(s), 10);
    dwell.rest('a', 'a');
    dwell.cancel();
    await wait(30);
    expect(fired).toEqual([]);
  });
});
