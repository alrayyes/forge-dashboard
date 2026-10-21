/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { ciPillModel } from './ci-pill';

const counts = { passed: 8, running: 1, waiting: 2, failed: 3 };

// One model for the pull request rows, the bots board, the issue pills and the
// Main branches page, so the three never word or class a pill differently.
describe('ciPillModel', () => {
  test('a segmented pill leads with its word and carries the counts', () => {
    const m = ciPillModel({
      cls: 'failure',
      glyph: 'failure',
      word: 'Failed',
      counts,
    });

    expect(m.classes).toBe('ci-pill failure segmented');
    expect(m.segments.map((s) => s.kind)).toEqual([
      'passed',
      'running',
      'waiting',
      'failed',
    ]);
    expect(m.name).toBe(
      'Failed 8 1 2 3: 8 passed, 1 running, 2 waiting, 3 failed',
    );
  });

  test('keeps waiting as the spoken word for queued checks', () => {
    const m = ciPillModel({
      cls: 'pending',
      glyph: 'running',
      word: 'Running',
      counts: { passed: 0, running: 1, waiting: 8, failed: 0 },
    });

    expect(m.name).toContain('8 waiting');
  });

  test('a plain pill has no segments and its own word as the name', () => {
    const m = ciPillModel({ cls: 'success', glyph: 'success', word: 'Passed' });

    expect(m.classes).toBe('ci-pill success');
    expect(m.segments).toEqual([]);
    expect(m.name).toBe('Passed');
  });

  test('a held pill adds the awaiting class and ignores counts', () => {
    const m = ciPillModel({
      cls: 'failure',
      glyph: 'awaiting_approval',
      word: 'Waiting for workflow approval',
      awaiting: true,
      counts,
    });

    expect(m.classes).toBe('ci-pill failure awaiting');
    expect(m.segments).toEqual([]);
  });

  test('an all-skipped pass says Skipped', () => {
    const m = ciPillModel({
      cls: 'success',
      glyph: 'success',
      word: 'Passed',
      counts: { passed: 2, skipped: 2, running: 0, waiting: 0, failed: 0 },
    });

    expect(m.word).toBe('Skipped');
    expect(m.name).toBe('Skipped 2: 2 skipped');
  });

  test('segmented false keeps the plain pill whatever the counts', () => {
    const m = ciPillModel({
      cls: 'cancelled',
      glyph: 'cancelled',
      word: 'Cancelled',
      counts,
      segmented: false,
    });

    expect(m.segments).toEqual([]);
  });
});
