/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createSpeaker } from './live-region';

// A screen reader speaks a live region when its text changes, so a line equal
// to the one already there is silent. The speaker empties the region first.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createSpeaker', () => {
  test('empties the region, then sets the line', async () => {
    const written: string[] = [];
    const speak = createSpeaker((text) => written.push(text), 5);
    speak('Checks updated: 2 checks changed.');
    expect(written).toEqual(['']);
    await wait(30);
    expect(written).toEqual(['', 'Checks updated: 2 checks changed.']);
  });

  test('says an identical line again after emptying in between', async () => {
    const written: string[] = [];
    const speak = createSpeaker((text) => written.push(text), 5);
    speak('same');
    await wait(30);
    speak('same');
    await wait(30);
    expect(written).toEqual(['', 'same', '', 'same']);
  });

  test('a newer line replaces one still waiting', async () => {
    const written: string[] = [];
    const speak = createSpeaker((text) => written.push(text), 5);
    speak('first');
    speak('second');
    await wait(30);
    expect(written).toEqual(['', '', 'second']);
  });

  test('clear empties the region and drops a waiting line', async () => {
    const written: string[] = [];
    const speak = createSpeaker((text) => written.push(text), 5);
    speak('late');
    speak.clear();
    await wait(30);
    expect(written).toEqual(['', '']);
  });
});
