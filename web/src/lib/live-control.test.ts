/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { liveStatus, pauseLabel, updatedText } from './live-control.js';

const NOW = Date.parse('2026-11-13T10:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

describe('updatedText', () => {
  test('counts seconds, then minutes, hours and days', () => {
    expect(updatedText(ago(12), NOW)).toBe('updated 12s ago');
    expect(updatedText(ago(125), NOW)).toBe('updated 2m ago');
    expect(updatedText(ago(3 * 3600), NOW)).toBe('updated 3h ago');
    expect(updatedText(ago(2 * 86400), NOW)).toBe('updated 2d ago');
  });

  test('never reads negative when the clock is a little behind', () => {
    expect(updatedText(ago(-3), NOW)).toBe('updated 0s ago');
  });

  test('says nothing for no time or the zero time', () => {
    expect(updatedText(null, NOW)).toBe('');
    expect(updatedText('0001-01-01T00:00:00Z', NOW)).toBe('');
  });

  test('moves only when the snapshot time does, so a failed refresh stands still', () => {
    const t = ago(30);
    expect(updatedText(t, NOW + 5000)).toBe('updated 35s ago');
    // The same generatedAt later is just the clock; a new one resets it.
    expect(updatedText(ago(0), NOW + 5000)).toBe('updated 5s ago');
  });
});

describe('liveStatus and pauseLabel', () => {
  test('read Live and Pause, or Paused and Resume', () => {
    expect(liveStatus(false)).toBe('Live');
    expect(liveStatus(true)).toBe('Paused');
    expect(pauseLabel(false)).toEqual({
      text: 'Pause',
      name: 'Pause live updates',
    });
    expect(pauseLabel(true)).toEqual({
      text: 'Resume',
      name: 'Resume live updates',
    });
  });

  test('the name always contains the visible text (WCAG 2.5.3)', () => {
    for (const p of [false, true])
      expect(pauseLabel(p).name).toContain(pauseLabel(p).text);
  });
});
