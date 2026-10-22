/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  chipLabel,
  healthSentence,
  isOutage,
  staleNote,
} from './forge-starting';

const base = { forge: 'github', reachable: false };
const starting = { ...base, starting: true };

describe('forge-starting', () => {
  test('a forge that has not been asked yet is loading, never unreachable', () => {
    expect(chipLabel('GitHub', starting)).toBe('GitHub loading');
    expect(healthSentence('GitHub', starting)).toBe('GitHub starting up');
    expect(isOutage(starting)).toBe(false);
  });

  test('a forge whose fetch failed is still unreachable', () => {
    expect(chipLabel('GitHub', base)).toBe('GitHub unreachable');
    expect(healthSentence('GitHub', base)).toBe('GitHub unreachable');
    expect(isOutage(base)).toBe(true);
  });

  test('a reachable forge is reachable', () => {
    const ok = { forge: 'github', reachable: true };
    expect(chipLabel('GitHub', ok)).toBe('GitHub reachable');
    expect(isOutage(ok)).toBe(false);
  });

  test('the stale note says the app is starting up while no fetch has answered', () => {
    expect(staleNote(starting, 'a minute ago')).toBe(
      'Starting up, showing data from a minute ago',
    );
    expect(staleNote(base, 'a minute ago')).toBeNull();
    expect(staleNote({ ...base, staleSince: 'x' }, 'a minute ago')).toBe(
      'Showing data from a minute ago',
    );
  });
});
