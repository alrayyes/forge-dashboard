/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { factsOf } from './check-facts-fixture';
import { checkState } from './pipeline-checks';
import {
  announceChange,
  checkKeys,
  keepOrder,
  runSignature,
} from './pipeline-live';

describe('keepOrder', () => {
  const c = (name: string, state: string) => ({
    name,
    ...factsOf(state),
    url: '',
  });

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
    expect(keepOrder(prev, next).map(checkState)).toEqual([
      'failure',
      'success',
    ]);
  });
});

describe('announceChange', () => {
  const c = (name: string, state: string) => ({
    name,
    ...factsOf(state),
    url: '',
  });

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

describe('checkKeys', () => {
  const c = (name: string) => ({ name, status: 'in_progress', url: '' });

  test('is the name for a name that stands alone', () => {
    expect(checkKeys([c('build'), c('test')])).toEqual(['build', 'test']);
  });

  test('counts the nth check of a shared name', () => {
    expect(checkKeys([c('job'), c('x'), c('job')])).toEqual([
      'job',
      'x',
      'job#2',
    ]);
  });

  test('does not depend on where in the list a check stands', () => {
    expect(checkKeys([c('x'), c('job')])[1]).toBe(checkKeys([c('job')])[0]);
  });
});

describe('runSignature', () => {
  const c = (
    name: string,
    state: string,
    runId?: number,
    runAttempt?: number,
  ) => ({
    name,
    ...factsOf(state),
    url: '',
    runId,
    runAttempt,
  });

  test('is the same for the same facts in any order', () => {
    const a = [c('build', 'success', 7, 1), c('test', 'running', 7, 1)];

    expect(runSignature([...a].reverse())).toBe(runSignature(a));
  });

  test('changes when a check changes state', () => {
    expect(runSignature([c('build', 'running', 7, 1)])).not.toBe(
      runSignature([c('build', 'failure', 7, 1)]),
    );
  });

  test('changes when a rerun starts a new attempt of the same run', () => {
    expect(runSignature([c('build', 'failure', 7, 1)])).not.toBe(
      runSignature([c('build', 'failure', 7, 2)]),
    );
  });

  test('changes when a new run replaces the old one', () => {
    expect(runSignature([c('build', 'failure', 7)])).not.toBe(
      runSignature([c('build', 'failure', 8)]),
    );
  });

  test('changes when only the conclusion changes', () => {
    expect(runSignature([c('build', 'failure', 7, 1)])).not.toBe(
      runSignature([c('build', 'cancelled', 7, 1)]),
    );
  });

  test('changes when only the url changes', () => {
    const at = (url: string) => [{ ...c('build', 'failure', 7, 1), url }];

    expect(runSignature(at('https://x/job/1'))).not.toBe(
      runSignature(at('https://x/job/2')),
    );
  });

  test('keeps two checks apart whose fields run together', () => {
    const one = [{ ...c('a', 'failure', 7, 1), url: 'b:c' }];
    const two = [{ ...c('a:b', 'failure', 7, 1), url: 'c' }];

    expect(runSignature(one)).not.toBe(runSignature(two));
  });

  test('is empty for no checks', () => {
    expect(runSignature([])).toBe('');
  });
});
