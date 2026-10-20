/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  announceChange,
  ciSignature,
  createLiveChecks,
  keepOrder,
} from './pipeline-live';

const counts = (passed: number, running: number, waiting = 0, failed = 0) => ({
  passed,
  running,
  waiting,
  failed,
});

describe('ciSignature', () => {
  test('is the same for the same status and counts', () => {
    expect(ciSignature({ ci: 'pending', checks: counts(1, 2) })).toBe(
      ciSignature({ ci: 'pending', checks: counts(1, 2) }),
    );
  });

  test('differs when a count moves', () => {
    expect(ciSignature({ ci: 'pending', checks: counts(1, 2) })).not.toBe(
      ciSignature({ ci: 'pending', checks: counts(2, 1) }),
    );
  });

  test('differs when the run changes under the same counts', () => {
    expect(ciSignature({ ci: 'success', runUrl: 'a' })).not.toBe(
      ciSignature({ ci: 'success', runUrl: 'b' }),
    );
  });

  test('reads an older server with no counts without failing', () => {
    expect(ciSignature({ ci: 'success' })).toBe(ciSignature({ ci: 'success' }));
  });
});

describe('createLiveChecks', () => {
  function setup(paused = false) {
    const state = { paused, reloads: 0, stale: [] as boolean[] };
    const live = createLiveChecks({
      signature: 'a',
      paused: () => state.paused,
      reload: () => {
        state.reloads++;
      },
      onStale: (s) => state.stale.push(s),
    });
    return { state, live };
  }

  test('makes no request while the signature stays the same', () => {
    const { state, live } = setup();
    live.seen('a');
    live.seen('a');
    expect(state.reloads).toBe(0);
  });

  test('reads once per change', () => {
    const { state, live } = setup();
    live.seen('b');
    live.seen('b');
    live.seen('c');
    expect(state.reloads).toBe(2);
  });

  test('ignores a snapshot that no longer has the item', () => {
    const { state, live } = setup();
    live.seen(null);
    expect(state.reloads).toBe(0);
  });

  test('makes no request while paused, and says the checks may be old', () => {
    const { state, live } = setup(true);
    live.seen('b');
    expect(state.reloads).toBe(0);
    expect(state.stale).toEqual([true]);
  });

  test('reads once on resume when something changed while paused', () => {
    const { state, live } = setup(true);
    live.seen('b');
    state.paused = false;
    live.resume();
    live.resume();
    expect(state.reloads).toBe(1);
    expect(state.stale).toEqual([true, false]);
  });

  test('resume with nothing missed reads nothing', () => {
    const { state, live } = setup(true);
    live.resume();
    expect(state.reloads).toBe(0);
  });

  test('after a failed read the next snapshot tries again', () => {
    const { state, live } = setup();
    live.seen('b');
    live.failed();
    live.seen('b');
    expect(state.reloads).toBe(2);
  });

  test('a fresh read by hand clears the stale note', () => {
    const { state, live } = setup(true);
    live.seen('b');
    live.refreshed();
    expect(state.stale).toEqual([true, false]);
  });
});

describe('keepOrder', () => {
  const c = (name: string, state: string) => ({ name, state, url: '' });

  test('keeps the order checks already have, whatever the new order says', () => {
    const prev = [c('lint', 'running'), c('test', 'running')];
    const next = [c('test', 'failure'), c('lint', 'success')];
    expect(keepOrder(prev, next).map((x) => x.name)).toEqual(['lint', 'test']);
  });

  test('puts a new check last', () => {
    const prev = [c('lint', 'running')];
    const next = [c('new', 'queued'), c('lint', 'success')];
    expect(keepOrder(prev, next).map((x) => x.name)).toEqual(['lint', 'new']);
  });

  test('drops a check that is gone', () => {
    const prev = [c('a', 'running'), c('b', 'running')];
    expect(keepOrder(prev, [c('b', 'success')]).map((x) => x.name)).toEqual([
      'b',
    ]);
  });

  test('keeps two checks with the same name apart', () => {
    const prev = [c('job', 'running'), c('job', 'success')];
    const next = [c('job', 'failure'), c('job', 'success')];
    expect(keepOrder(prev, next).map((x) => x.state)).toEqual([
      'failure',
      'success',
    ]);
  });
});

describe('announceChange', () => {
  const c = (name: string, state: string) => ({ name, state, url: '' });

  test('says nothing when no check changed state', () => {
    expect(announceChange([c('a', 'running')], [c('a', 'running')])).toBe('');
  });

  test('names a single change', () => {
    expect(announceChange([c('a', 'running')], [c('a', 'success')])).toBe(
      'Checks updated: a is now Passed.',
    );
  });

  test('counts several changes', () => {
    expect(
      announceChange(
        [c('a', 'running'), c('b', 'running'), c('c', 'running')],
        [c('a', 'success'), c('b', 'failure'), c('c', 'running')],
      ),
    ).toBe('Checks updated: 2 checks changed.');
  });
});
